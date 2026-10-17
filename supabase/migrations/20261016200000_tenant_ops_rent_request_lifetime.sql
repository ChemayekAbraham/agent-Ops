-- Tenant Ops: all-time rent request journey and financed repayment outcome. ONE NEW read-only function, tenant_ops_rent_request_lifetime(),
-- no date parameters. Nothing existing is altered, nothing is written, no index is added. Money is read, never moved.
--
-- Access: the same check as ops_tenant_ops_home_range: is_ops_role (manager, super_admin, coo, operations, enabled roles only) or manager,
-- super_admin, cto, ceo, coo via has_role; anyone else, and a missing user, is refused with SQLSTATE 42501.
-- SECURITY DEFINER, STABLE, search_path = public. EXECUTE for authenticated only (revoked from PUBLIC, anon, service_role).
--
-- Definitions (the only ones; also in supabase/AGENTS.md):
--   submitted        count of every row in rent_requests.
--   stage_funnel     eight rows in pipeline order: service_center, agent_ops, tenant_ops, landlord_ops, partner_ops, coo, funded, financed.
--                    A row counts the requests that CLEARED that stage or any later one ("passed"), so each row is at most the row above.
--                    Cleared stages of a request that is still moving come from its current status, in the order of src/lib/rentPipelineStages.ts
--                    (aliases included): service_center_review 0; pending 1; agent_ops_approved / agent_verified 2; tenant_ops_approved 3;
--                    landlord_ops_approved 4; partner_ops_approved 5; coo_approved / approved 6; funded, disbursed, repaying, completed,
--                    fully_repaid 6. Funding evidence moves a request to 7 (funded_at is not null) and financing evidence to 8 (financed below).
--                    A request that ended (rejected, cancelled, deleted_by_agent, defaulted) is placed by the latest *_reviewed_at it has
--                    (service_center 1, agent_ops 2, tenant_ops 3, landlord_ops 4, partner_ops 5, coo 6): that stage was REACHED and its
--                    review was the one that ended it, so it cleared the stages before it (reviewed stage minus 1); with no review at all it
--                    clears nothing. A *_reviewed_at on its own never counts as an approval, and funded_at / financed still win for an ended request.
--   outcomes         waiting_service_centre = status service_center_review; pending = status pending; rejected; deleted_by_agent; cancelled.
--   funded           funded_at is not null.
--   financed         the request has a non-cancelled agent_landlord_float_allocations row with paid_out_amount > 0;
--                    landlord_paid_at = min(updated_at) of those rows.
--   repayment        over financed, mutually exclusive, adds up to financed:
--                      full        status = completed, or total_repayment > 0 and amount_repaid >= total_repayment
--                      partial     amount_repaid > 0 and not full
--                      never_paid  amount_repaid = 0, not full, and landlord_paid_at is more than 30 days ago
--                      too_early   amount_repaid = 0, not full, and landlord_paid_at is 30 days ago or less
--   financed_now_closed  financed requests whose status is now rejected, cancelled or deleted_by_agent (each is also in exactly one bucket above).
--   funded_not_financed  funded and not financed.
--   money            total_repayment and amount_repaid summed over financed requests (UGX as stored).
-- Rollback: supabase/rollbacks/20261016200000_tenant_ops_rent_request_lifetime.rollback.sql

CREATE OR REPLACE FUNCTION public.tenant_ops_rent_request_lifetime()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_out jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'cto'::app_role) OR public.has_role(auth.uid(), 'ceo'::app_role) OR public.has_role(auth.uid(), 'coo'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  WITH alf AS (
    SELECT a.rent_request_id AS rid, min(a.updated_at) AS paid_at
      FROM public.agent_landlord_float_allocations a
     WHERE a.rent_request_id IS NOT NULL AND a.status <> 'cancelled' AND COALESCE(a.paid_out_amount, 0) > 0
     GROUP BY a.rent_request_id
  ),
  rr AS (
    SELECT r.id, r.status, r.funded_at, COALESCE(r.amount_repaid, 0) AS repaid, COALESCE(r.total_repayment, 0) AS total,
           alf.paid_at, (alf.rid IS NOT NULL) AS financed,
           CASE
             WHEN r.status IN ('rejected', 'cancelled', 'deleted_by_agent', 'defaulted') THEN
               GREATEST(GREATEST(
                 CASE WHEN r.service_center_reviewed_at IS NOT NULL THEN 1 ELSE 0 END,
                 CASE WHEN r.agent_ops_reviewed_at IS NOT NULL THEN 2 ELSE 0 END,
                 CASE WHEN r.tenant_ops_reviewed_at IS NOT NULL THEN 3 ELSE 0 END,
                 CASE WHEN r.landlord_ops_reviewed_at IS NOT NULL THEN 4 ELSE 0 END,
                 CASE WHEN r.partner_ops_reviewed_at IS NOT NULL THEN 5 ELSE 0 END,
                 CASE WHEN r.coo_reviewed_at IS NOT NULL THEN 6 ELSE 0 END) - 1, 0)
             WHEN r.status = 'pending' THEN 1
             WHEN r.status IN ('agent_ops_approved', 'agent_verified') THEN 2
             WHEN r.status = 'tenant_ops_approved' THEN 3
             WHEN r.status = 'landlord_ops_approved' THEN 4
             WHEN r.status = 'partner_ops_approved' THEN 5
             WHEN r.status IN ('coo_approved', 'approved', 'funded', 'disbursed', 'repaying', 'completed', 'fully_repaid') THEN 6
             ELSE 0
           END AS base
      FROM public.rent_requests r
      LEFT JOIN alf ON alf.rid = r.id
  ),
  lv AS (
    SELECT rr.*,
           CASE WHEN rr.financed THEN 8 WHEN rr.funded_at IS NOT NULL THEN 7 ELSE rr.base END AS cleared,
           (rr.repaid >= rr.total AND rr.total > 0) OR rr.status = 'completed' AS is_full
      FROM rr
  ),
  fin AS (
    SELECT lv.*,
           CASE
             WHEN lv.is_full THEN 'full'
             WHEN lv.repaid > 0 THEN 'partial'
             WHEN lv.paid_at < now() - interval '30 days' THEN 'never_paid'
             ELSE 'too_early'
           END AS bucket
      FROM lv WHERE lv.financed
  )
  SELECT jsonb_build_object(
    'as_at', (now() AT TIME ZONE 'Africa/Kampala')::date,
    'basis', 'All time, not tied to any date range. A funnel row counts the requests that cleared that stage or a later one. Financed means a landlord payment was made out of the agent float allocation; the repayment buckets add up to financed.',
    'submitted', (SELECT count(*) FROM lv),
    'stage_funnel', (
      SELECT jsonb_agg(jsonb_build_object('stage', s.stage, 'count', (SELECT count(*) FROM lv WHERE lv.cleared >= s.ord)) ORDER BY s.ord)
        FROM (VALUES (1, 'service_center'), (2, 'agent_ops'), (3, 'tenant_ops'), (4, 'landlord_ops'), (5, 'partner_ops'), (6, 'coo'), (7, 'funded'), (8, 'financed')) AS s(ord, stage)),
    'outcomes', jsonb_build_object(
      'waiting_service_centre', (SELECT count(*) FROM lv WHERE lv.status = 'service_center_review'),
      'pending', (SELECT count(*) FROM lv WHERE lv.status = 'pending'),
      'rejected', (SELECT count(*) FROM lv WHERE lv.status = 'rejected'),
      'deleted_by_agent', (SELECT count(*) FROM lv WHERE lv.status = 'deleted_by_agent'),
      'cancelled', (SELECT count(*) FROM lv WHERE lv.status = 'cancelled')),
    'funded', (SELECT count(*) FROM lv WHERE lv.funded_at IS NOT NULL),
    'financed', (SELECT count(*) FROM fin),
    'repayment', jsonb_build_object(
      'full', (SELECT count(*) FROM fin WHERE fin.bucket = 'full'),
      'partial', (SELECT count(*) FROM fin WHERE fin.bucket = 'partial'),
      'never_paid', (SELECT count(*) FROM fin WHERE fin.bucket = 'never_paid'),
      'too_early', (SELECT count(*) FROM fin WHERE fin.bucket = 'too_early')),
    'financed_now_closed', (SELECT count(*) FROM fin WHERE fin.status IN ('rejected', 'cancelled', 'deleted_by_agent')),
    'funded_not_financed', (SELECT count(*) FROM lv WHERE lv.funded_at IS NOT NULL AND NOT lv.financed),
    'money', jsonb_build_object(
      'total_repayment', (SELECT COALESCE(sum(fin.total), 0) FROM fin),
      'amount_repaid', (SELECT COALESCE(sum(fin.repaid), 0) FROM fin))
  ) INTO v_out;
  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.tenant_ops_rent_request_lifetime() IS 'Tenant Ops: all-time rent request journey and financed repayment outcome. Read-only, no date parameters.';

REVOKE ALL ON FUNCTION public.tenant_ops_rent_request_lifetime() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.tenant_ops_rent_request_lifetime() TO authenticated;
