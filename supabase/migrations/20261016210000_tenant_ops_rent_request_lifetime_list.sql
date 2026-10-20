-- Tenant Ops all-time rent request cards, part 2: the lists behind three of the rows, and two additive fields on the summary.
--
--   _tor_lifetime_rows()                                   owner-only helper: one row per rent request with the lifetime classification
--                                                          (cleared stage, financed, repayment bucket). The summary and the list both read it, so a
--                                                          list can never disagree with its count.
--   tenant_ops_rent_request_lifetime()                     REPLACED with the same figures and the same rules (now reading the helper); adds
--                                                          generated_at (server time of the answer) and outcomes.in_approval (every request that
--                                                          is between pending and COO approval: status pending, agent_ops_approved, agent_verified,
--                                                          tenant_ops_approved, landlord_ops_approved, partner_ops_approved, coo_approved, approved).
--                                                          No existing figure or rule changes; supabase/tests/tenant_ops_rent_request_lifetime.sql still applies.
--   tenant_ops_rent_request_lifetime_list(p_bucket, p_limit, p_offset)   NEW: the requests behind 'never_paid', 'funded_not_financed' and
--                                                          'financed_now_closed', exactly the rules of the summary. Same role check and error codes.
--                                                          never_paid: oldest landlord payment first; funded_not_financed: funded longest ago first;
--                                                          financed_now_closed: most recent landlord payment first. p_limit is clamped to 1..200,
--                                                          p_offset to 0 or more. tenant and agent names from profiles (the agent is COALESCE(assigned_agent_id, agent_id)).
--                                                          landlord_paid_at = min(updated_at) of the non-cancelled landlord allocation rows with paid_out_amount > 0
--                                                          (approximate until a real paid-at date is stored).
-- Read-only, SECURITY DEFINER, STABLE, search_path = public. EXECUTE for authenticated only (the helper: nobody but the owner).
-- Rollback: supabase/rollbacks/20261016210000_tenant_ops_rent_request_lifetime_list.rollback.sql

CREATE OR REPLACE FUNCTION public._tor_lifetime_rows()
RETURNS TABLE (id uuid, status text, funded_at timestamptz, repaid numeric, total numeric, paid_at timestamptz, financed boolean, cleared integer, bucket text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
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
  )
  SELECT rr.id, rr.status, rr.funded_at, rr.repaid, rr.total, rr.paid_at, rr.financed,
         CASE WHEN rr.financed THEN 8 WHEN rr.funded_at IS NOT NULL THEN 7 ELSE rr.base END,
         CASE
           WHEN NOT rr.financed THEN NULL
           WHEN (rr.repaid >= rr.total AND rr.total > 0) OR rr.status = 'completed' THEN 'full'
           WHEN rr.repaid > 0 THEN 'partial'
           WHEN rr.paid_at < now() - interval '30 days' THEN 'never_paid'
           ELSE 'too_early'
         END
    FROM rr;
$function$;

REVOKE ALL ON FUNCTION public._tor_lifetime_rows() FROM PUBLIC, anon, authenticated, service_role;

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

  WITH lv AS MATERIALIZED (SELECT * FROM public._tor_lifetime_rows()),
  fin AS (SELECT * FROM lv WHERE lv.financed)
  SELECT jsonb_build_object(
    'as_at', (now() AT TIME ZONE 'Africa/Kampala')::date,
    'generated_at', now(),
    'basis', 'All time, not tied to any date range. A funnel row counts the requests that cleared that stage or a later one. Financed means a landlord payment was made out of the agent float allocation; the repayment buckets add up to financed.',
    'submitted', (SELECT count(*) FROM lv),
    'stage_funnel', (
      SELECT jsonb_agg(jsonb_build_object('stage', s.stage, 'count', (SELECT count(*) FROM lv WHERE lv.cleared >= s.ord)) ORDER BY s.ord)
        FROM (VALUES (1, 'service_center'), (2, 'agent_ops'), (3, 'tenant_ops'), (4, 'landlord_ops'), (5, 'partner_ops'), (6, 'coo'), (7, 'funded'), (8, 'financed')) AS s(ord, stage)),
    'outcomes', jsonb_build_object(
      'waiting_service_centre', (SELECT count(*) FROM lv WHERE lv.status = 'service_center_review'),
      'pending', (SELECT count(*) FROM lv WHERE lv.status = 'pending'),
      'in_approval', (SELECT count(*) FROM lv WHERE lv.status IN ('pending', 'agent_ops_approved', 'agent_verified', 'tenant_ops_approved', 'landlord_ops_approved', 'partner_ops_approved', 'coo_approved', 'approved')),
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

CREATE OR REPLACE FUNCTION public.tenant_ops_rent_request_lifetime_list(p_bucket text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS TABLE (
  id uuid, tenant_name text, agent_name text, rent_amount numeric, total_repayment numeric, amount_repaid numeric,
  landlord_paid_at timestamptz, funded_at timestamptz, status text, total_matched bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
#variable_conflict use_column
DECLARE
  v_bucket text := lower(btrim(COALESCE(p_bucket, '')));
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF auth.uid() IS NULL OR NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'cto'::app_role) OR public.has_role(auth.uid(), 'ceo'::app_role) OR public.has_role(auth.uid(), 'coo'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_bucket NOT IN ('never_paid', 'funded_not_financed', 'financed_now_closed') THEN
    RAISE EXCEPTION 'BUCKET_INVALID: p_bucket must be never_paid, funded_not_financed or financed_now_closed' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH picked AS MATERIALIZED (
    SELECT l.*
      FROM public._tor_lifetime_rows() l
     WHERE (v_bucket = 'never_paid' AND l.bucket = 'never_paid')
        OR (v_bucket = 'funded_not_financed' AND l.funded_at IS NOT NULL AND NOT l.financed)
        OR (v_bucket = 'financed_now_closed' AND l.financed AND l.status IN ('rejected', 'cancelled', 'deleted_by_agent'))
  )
  SELECT r.id, COALESCE(tp.full_name, 'Unnamed tenant'), COALESCE(ap.full_name, 'Unnamed agent'),
         r.rent_amount, COALESCE(r.total_repayment, 0), COALESCE(r.amount_repaid, 0),
         k.paid_at, k.funded_at, k.status, count(*) OVER ()
    FROM picked k
    JOIN public.rent_requests r ON r.id = k.id
    LEFT JOIN public.profiles tp ON tp.id = r.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = COALESCE(r.assigned_agent_id, r.agent_id)
   ORDER BY CASE v_bucket
              WHEN 'financed_now_closed' THEN -extract(epoch FROM k.paid_at)
              WHEN 'funded_not_financed' THEN extract(epoch FROM k.funded_at)
              ELSE extract(epoch FROM k.paid_at)
            END NULLS LAST, k.id
   OFFSET v_offset LIMIT v_limit;
END;
$function$;

COMMENT ON FUNCTION public.tenant_ops_rent_request_lifetime_list(text, integer, integer) IS 'Tenant Ops: the requests behind the never paid, funded not financed and financed now closed rows of the all-time cards. Read-only.';

REVOKE ALL ON FUNCTION public.tenant_ops_rent_request_lifetime_list(text, integer, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.tenant_ops_rent_request_lifetime_list(text, integer, integer) TO authenticated;
