-- Rollback of 20261108120000: restores the 20261108090000 definitions (receipt-based collected). No data is touched.
BEGIN;
DROP FUNCTION IF EXISTS public.get_cfo_tenant_repayment_register();
DROP FUNCTION IF EXISTS public._cfo_tenant_repayment_rows(uuid);

-- ------------------------------------------------------------------ private helper: one row per Rent Plan
CREATE OR REPLACE FUNCTION public._cfo_tenant_repayment_rows(p_only uuid DEFAULT NULL)
 RETURNS TABLE (
   rent_request_id uuid, status text, tenant_id uuid, tenant_name text, tenant_phone text, agent_id uuid, agent_name text,
   landlord_name text, funded_at timestamptz, clock_bucket text, clock_start date, clock_end date, duration_days integer,
   principal numeric, access_fee numeric, request_fee numeric, fees numeric, obligation numeric, disbursed numeric,
   verified_collected numeric, receipts_count integer, last_receipt_at timestamptz, reversed_amount numeric, reversed_count integer,
   ledger_backed_amount numeric, unverified_amount numeric, unverified_count integer,
   stored_repaid numeric, stored_outstanding numeric, calc_outstanding numeric, progress_pct numeric, repaid_without_receipts numeric,
   manual_reduction_total numeric, manual_reduction_count integer, unreceipted_repaid_increase numeric, obligation_reduced numeric,
   last_adjustment_at timestamptz, books_receivable numeric, receipts_not_posted integer,
   expected_to_date numeric, arrears numeric, days_behind integer, is_legacy boolean, exceptions text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH plans AS MATERIALIZED (
    SELECT rr.id, rr.status, rr.tenant_id, rr.agent_id, rr.landlord_id, rr.funded_at, rr.disbursed_at, rr.created_at,
           COALESCE(rr.rent_amount, 0) principal, COALESCE(rr.access_fee, 0) access_fee, COALESCE(rr.request_fee, 0) request_fee,
           COALESCE(rr.total_repayment, 0) obligation, COALESCE(rr.amount_repaid, 0) stored_repaid, COALESCE(rr.duration_days, 0) duration_days,
           ((COALESCE(rr.funded_at, rr.disbursed_at, rr.created_at) AT TIME ZONE 'Africa/Kampala')::date < DATE '2026-10-01') is_legacy
    FROM public.rent_requests rr
    WHERE (p_only IS NULL OR rr.id = p_only)
      AND (rr.funded_at IS NOT NULL OR rr.disbursed_at IS NOT NULL OR rr.status IN ('funded', 'repaying', 'completed'))
  ),
  ids AS (SELECT array_agg(id) a FROM plans),
  coll AS (
    SELECT c.rent_request_id id,
           sum(c.amount) FILTER (WHERE c.reversed_at IS NULL AND COALESCE(c.notes, '') NOT ILIKE '%[REVERSED:%') amt,
           count(*) FILTER (WHERE c.reversed_at IS NULL AND COALESCE(c.notes, '') NOT ILIKE '%[REVERSED:%') n,
           max(c.created_at) FILTER (WHERE c.reversed_at IS NULL AND COALESCE(c.notes, '') NOT ILIKE '%[REVERSED:%') last_at,
           sum(c.amount) FILTER (WHERE c.reversed_at IS NOT NULL OR COALESCE(c.notes, '') ILIKE '%[REVERSED:%') rev_amt,
           count(*) FILTER (WHERE c.reversed_at IS NOT NULL OR COALESCE(c.notes, '') ILIKE '%[REVERSED:%') rev_n,
           count(*) FILTER (WHERE c.reversed_at IS NULL AND COALESCE(c.notes, '') NOT ILIKE '%[REVERSED:%'
                              AND c.created_at >= TIMESTAMPTZ '2026-10-01 00:00:00+03'
                              AND NOT EXISTS (
                                SELECT 1 FROM public.general_ledger g
                                 WHERE ((g.source_table = 'agent_collections' AND g.source_id = c.rent_request_id)
                                     OR (g.source_table = 'deposit_requests' AND g.source_id = c.deposit_request_id))
                                   AND g.category IN ('tenant_repayment', 'tenant_repayment_collected')
                                   AND g.ledger_scope = 'platform' AND g.direction = 'cash_in' AND g.amount = c.amount
                                   AND abs(extract(epoch FROM g.created_at - c.created_at)) < 300)) not_posted
    FROM public.agent_collections c JOIN plans p ON p.id = c.rent_request_id
    GROUP BY 1
  ),
  orphan AS (
    SELECT r.rent_request_id id, r.amount, r.created_at,
           EXISTS (SELECT 1 FROM public.general_ledger g
                    WHERE g.source_table IN ('agent_collections', 'rent_requests') AND g.source_id = r.rent_request_id
                      AND g.category IN ('tenant_repayment', 'tenant_repayment_collected') AND g.ledger_scope = 'platform'
                      AND g.direction = 'cash_in' AND g.amount = r.amount AND abs(extract(epoch FROM g.created_at - r.created_at)) < 300) backed
    FROM public.repayments r JOIN plans p ON p.id = r.rent_request_id
    WHERE NOT EXISTS (SELECT 1 FROM public.agent_collections c WHERE c.rent_request_id = r.rent_request_id AND c.amount = r.amount
                        AND abs(extract(epoch FROM c.created_at - r.created_at)) < 120)
  ),
  orph AS (
    SELECT id, sum(amount) FILTER (WHERE backed) backed_amt, sum(amount) FILTER (WHERE NOT backed) unverified_amt,
           count(*) FILTER (WHERE NOT backed) unverified_n
    FROM orphan GROUP BY 1
  ),
  led AS (
    SELECT p.id, x.recv, x.disbursed
    FROM plans p CROSS JOIN LATERAL (
      SELECT sum(CASE WHEN g.category IN ('rent_receivable_created', 'fee_receivable_created')
                      THEN CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END END) recv,
             sum(CASE WHEN g.category = 'rent_disbursement' THEN CASE WHEN g.direction = 'cash_out' THEN g.amount ELSE -g.amount END END) disbursed
      FROM public.general_ledger g
      WHERE g.source_table = 'rent_requests' AND g.source_id = p.id
        AND g.category IN ('rent_receivable_created', 'fee_receivable_created', 'rent_disbursement')
        AND g.ledger_scope IN ('bridge', 'platform')
    ) x
  ),
  edits AS (
    SELECT id, sum(reduction) reduction, count(*) n, max(at) last_at FROM (
      SELECT e.rent_request_id id, GREATEST(COALESCE(e.old_outstanding, 0) - COALESCE(e.new_outstanding, 0), 0) reduction,
             COALESCE(e.applied_at, e.decided_at, e.created_at) at
        FROM public.tenant_balance_edits e WHERE e.status = 'approved'
      UNION ALL
      SELECT l.rent_request_id, GREATEST(COALESCE(l.old_amount, 0) - COALESCE(l.final_amount, l.new_amount, 0), 0), l.created_at
        FROM public.landlord_payment_edits l
       WHERE l.edit_type = 'outstanding_balance' AND NOT COALESCE(l.reverted_on_dispute, false)
         -- the operations payment-edit flow records the same change in both tables: count it once
         AND NOT EXISTS (SELECT 1 FROM public.tenant_balance_edits e
                          WHERE e.rent_request_id = l.rent_request_id AND e.status = 'approved'
                            AND abs(COALESCE(e.old_outstanding, 0) - COALESCE(l.old_amount, 0)) < 1
                            AND abs(COALESCE(e.new_outstanding, 0) - COALESCE(l.final_amount, l.new_amount, 0)) < 1
                            AND abs(extract(epoch FROM e.created_at - l.created_at)) < 600)
    ) z JOIN plans p USING (id) GROUP BY id
  ),
  chg AS (
    SELECT l.rent_request_id id,
           sum(COALESCE(l.new_amount_repaid, 0) - COALESCE(l.old_amount_repaid, 0)) FILTER (
             WHERE COALESCE(l.new_amount_repaid, 0) > COALESCE(l.old_amount_repaid, 0)
               AND NOT EXISTS (SELECT 1 FROM public.agent_collections c
                                WHERE c.rent_request_id = l.rent_request_id
                                  AND c.amount = COALESCE(l.new_amount_repaid, 0) - COALESCE(l.old_amount_repaid, 0)
                                  AND abs(extract(epoch FROM c.created_at - l.changed_at)) < 120)) unreceipted_inc,
           sum(COALESCE(l.old_total_repayment, 0) - COALESCE(l.new_total_repayment, 0)) FILTER (
             WHERE l.new_total_repayment IS NOT NULL AND l.old_total_repayment IS NOT NULL
               AND l.new_total_repayment < l.old_total_repayment AND p.funded_at IS NOT NULL AND l.changed_at > p.funded_at) obligation_cut,
           max(l.changed_at) FILTER (WHERE l.source IS NOT NULL) last_at
    FROM public.rent_amount_change_log l JOIN plans p ON p.id = l.rent_request_id
    GROUP BY 1
  ),
  clk AS (SELECT * FROM public.am_plan_clock((SELECT a FROM ids))),
  arr AS (SELECT * FROM public.am_plan_arrears((SELECT a FROM ids), NULL)),
  calc AS (
    SELECT p.*,
           COALESCE(c.amt, 0) + COALESCE(o.backed_amt, 0) verified,
           c.n receipts_n, c.last_at, COALESCE(c.rev_amt, 0) rev_amt, COALESCE(c.rev_n, 0) rev_n, COALESCE(c.not_posted, 0) not_posted,
           COALESCE(o.backed_amt, 0) backed_amt, COALESCE(o.unverified_amt, 0) unverified_amt, COALESCE(o.unverified_n, 0) unverified_n,
           l.recv, l.disbursed, COALESCE(e.reduction, 0) edit_reduction, COALESCE(e.n, 0) edit_n,
           COALESCE(ch.unreceipted_inc, 0) unreceipted_inc, COALESCE(ch.obligation_cut, 0) obligation_cut,
           GREATEST(e.last_at, ch.last_at) last_adj_at,
           k.bucket, k.clock_start, k.clock_end, a.expected_to_date, a.arrears, a.days_behind
    FROM plans p
    LEFT JOIN coll c ON c.id = p.id LEFT JOIN orph o ON o.id = p.id LEFT JOIN led l ON l.id = p.id
    LEFT JOIN edits e ON e.id = p.id LEFT JOIN chg ch ON ch.id = p.id
    LEFT JOIN clk k ON k.rent_request_id = p.id LEFT JOIN arr a ON a.rent_request_id = p.id
  )
  SELECT x.id, x.status, x.tenant_id, tp.full_name, tp.phone, x.agent_id, ap.full_name, ll.name, x.funded_at,
         x.bucket, x.clock_start, x.clock_end, x.duration_days,
         x.principal, x.access_fee, x.request_fee, x.access_fee + x.request_fee, x.obligation, x.disbursed,
         x.verified, COALESCE(x.receipts_n, 0)::integer, x.last_at, x.rev_amt, x.rev_n::integer,
         x.backed_amt, x.unverified_amt, x.unverified_n::integer,
         x.stored_repaid, GREATEST(x.obligation - x.stored_repaid, 0), GREATEST(x.obligation - x.verified, 0),
         CASE WHEN x.obligation > 0 THEN round(LEAST(x.verified / x.obligation, 1) * 100, 1) END,
         GREATEST(x.stored_repaid - x.verified, 0),
         x.edit_reduction, x.edit_n::integer, x.unreceipted_inc, x.obligation_cut, x.last_adj_at,
         x.recv, x.not_posted::integer, x.expected_to_date, x.arrears, x.days_behind, x.is_legacy,
         array_remove(ARRAY[
           CASE WHEN x.status = 'completed' AND x.obligation - x.verified >= 1000 THEN 'completed_with_balance' END,
           CASE WHEN x.stored_repaid - x.verified >= 1000 THEN 'repaid_without_receipts' END,
           CASE WHEN x.edit_reduction > 0 OR x.unreceipted_inc >= 1000 THEN 'manual_balance_reduction' END,
           CASE WHEN x.obligation_cut >= 1000 THEN 'obligation_reduced_after_funding' END,
           CASE WHEN x.verified - x.stored_repaid >= 1000 THEN 'receipts_exceed_recorded' END,
           CASE WHEN x.verified > x.obligation + 1000 THEN 'collected_more_than_owed' END,
           CASE WHEN x.unverified_n > 0 THEN 'unverified_repayment_records' END,
           CASE WHEN x.not_posted > 0 THEN 'receipt_not_in_ledger' END,
           CASE WHEN NOT x.is_legacy AND x.status IN ('funded', 'repaying', 'completed')
                     AND abs(COALESCE(x.recv, 0) - x.obligation) >= 1000 THEN 'books_obligation_mismatch' END
         ], NULL)
  FROM calc x
  LEFT JOIN public.profiles tp ON tp.id = x.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = x.agent_id
  LEFT JOIN public.landlords ll ON ll.id = x.landlord_id
  ORDER BY x.funded_at DESC NULLS LAST, x.created_at DESC
$function$;

REVOKE ALL ON FUNCTION public._cfo_tenant_repayment_rows(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._cfo_tenant_repayment_rows(uuid) TO service_role;

-- ------------------------------------------------------------------ access: CFO and super_admin only
CREATE OR REPLACE FUNCTION public._cfo_tenant_repayment_can_view()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT auth.uid() IS NOT NULL
     AND (public.has_role(auth.uid(), 'cfo'::app_role) OR public.has_role(auth.uid(), 'super_admin'::app_role))
$function$;
REVOKE ALL ON FUNCTION public._cfo_tenant_repayment_can_view() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._cfo_tenant_repayment_can_view() TO service_role;

-- ------------------------------------------------------------------ register
CREATE OR REPLACE FUNCTION public.get_cfo_tenant_repayment_register()
 RETURNS TABLE (
   rent_request_id uuid, status text, tenant_id uuid, tenant_name text, tenant_phone text, agent_id uuid, agent_name text,
   landlord_name text, funded_at timestamptz, clock_bucket text, clock_start date, clock_end date, duration_days integer,
   principal numeric, access_fee numeric, request_fee numeric, fees numeric, obligation numeric, disbursed numeric,
   verified_collected numeric, receipts_count integer, last_receipt_at timestamptz, reversed_amount numeric, reversed_count integer,
   ledger_backed_amount numeric, unverified_amount numeric, unverified_count integer,
   stored_repaid numeric, stored_outstanding numeric, calc_outstanding numeric, progress_pct numeric, repaid_without_receipts numeric,
   manual_reduction_total numeric, manual_reduction_count integer, unreceipted_repaid_increase numeric, obligation_reduced numeric,
   last_adjustment_at timestamptz, books_receivable numeric, receipts_not_posted integer,
   expected_to_date numeric, arrears numeric, days_behind integer, is_legacy boolean, exceptions text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '90s'
AS $function$
BEGIN
  IF NOT public._cfo_tenant_repayment_can_view() THEN
    RAISE EXCEPTION 'Not authorized: the Tenant Repayment Tracker is for the CFO' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM public._cfo_tenant_repayment_rows(NULL);
END $function$;
REVOKE ALL ON FUNCTION public.get_cfo_tenant_repayment_register() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cfo_tenant_repayment_register() TO authenticated, service_role;

-- ------------------------------------------------------------------ one plan: receipts, repayment records, adjustments, ledger
CREATE OR REPLACE FUNCTION public.get_cfo_tenant_repayment_detail(p_rent_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
DECLARE v_plan jsonb; v_funded timestamptz;
BEGIN
  IF NOT public._cfo_tenant_repayment_can_view() THEN
    RAISE EXCEPTION 'Not authorized: the Tenant Repayment Tracker is for the CFO' USING ERRCODE = '42501';
  END IF;
  SELECT to_jsonb(r) INTO v_plan FROM public._cfo_tenant_repayment_rows(p_rent_request_id) r;
  IF v_plan IS NULL THEN RAISE EXCEPTION 'Rent Plan not found or never funded' USING ERRCODE = 'P0002'; END IF;
  SELECT rr.funded_at INTO v_funded FROM public.rent_requests rr WHERE rr.id = p_rent_request_id;

  RETURN jsonb_build_object(
    'as_at', now(),
    'plan', v_plan,
    -- every receipt on the plan, newest first; reversed ones are listed but never counted
    'receipts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', c.id, 'at', c.created_at, 'amount', c.amount, 'method', c.payment_method::text,
               'reference', COALESCE(NULLIF(c.momo_transaction_id, ''), c.tracking_id), 'tracking_id', c.tracking_id,
               'agent', (SELECT pa.full_name FROM public.profiles pa WHERE pa.id = c.agent_id),
               'path', CASE WHEN c.deposit_request_id IS NOT NULL THEN 'tenant deposit' WHEN c.token_id IS NOT NULL THEN 'payment token'
                            WHEN c.visit_id IS NOT NULL THEN 'field visit' ELSE 'agent collection' END,
               'reversed', (c.reversed_at IS NOT NULL OR COALESCE(c.notes, '') ILIKE '%[REVERSED:%'),
               'reversed_at', c.reversed_at,
               'ledger_posted', EXISTS (
                 SELECT 1 FROM public.general_ledger g
                  WHERE ((g.source_table = 'agent_collections' AND g.source_id = c.rent_request_id)
                      OR (g.source_table = 'deposit_requests' AND g.source_id = c.deposit_request_id))
                    AND g.category IN ('tenant_repayment', 'tenant_repayment_collected')
                    AND g.ledger_scope = 'platform' AND g.direction = 'cash_in' AND g.amount = c.amount
                    AND abs(extract(epoch FROM g.created_at - c.created_at)) < 300),
               'ledger_checked', c.created_at >= TIMESTAMPTZ '2026-10-01 00:00:00+03',
               'notes', left(c.notes, 200)) ORDER BY c.created_at DESC)
      FROM (SELECT ac.* FROM public.agent_collections ac WHERE ac.rent_request_id = p_rent_request_id
             ORDER BY ac.created_at DESC LIMIT 1000) c), '[]'::jsonb),
    -- repayments rows with no receipt: counted only when the ledger carries the cash-in
    'repayment_records', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('at', r.created_at, 'amount', r.amount, 'method', r.payment_method,
               'reference', r.external_reference, 'ledger_backed', r.backed) ORDER BY r.created_at DESC)
      FROM (
        SELECT rp.*, EXISTS (SELECT 1 FROM public.general_ledger g
                              WHERE g.source_table IN ('agent_collections', 'rent_requests') AND g.source_id = rp.rent_request_id
                                AND g.category IN ('tenant_repayment', 'tenant_repayment_collected') AND g.ledger_scope = 'platform'
                                AND g.direction = 'cash_in' AND g.amount = rp.amount
                                AND abs(extract(epoch FROM g.created_at - rp.created_at)) < 300) backed
        FROM public.repayments rp
        WHERE rp.rent_request_id = p_rent_request_id
          AND NOT EXISTS (SELECT 1 FROM public.agent_collections c WHERE c.rent_request_id = rp.rent_request_id AND c.amount = rp.amount
                            AND abs(extract(epoch FROM c.created_at - rp.created_at)) < 120)) r), '[]'::jsonb),
    -- who changed a balance or the obligation, when and why (an adjustment, never a repayment)
    'adjustments', COALESCE((
      SELECT jsonb_agg(z.a ORDER BY (z.a->>'at') DESC) FROM (
        SELECT jsonb_build_object('at', COALESCE(e.applied_at, e.decided_at, e.created_at), 'kind', 'Tenant balance edit',
                 'status', e.status, 'by', COALESCE(e.editor_name, (SELECT pe.full_name FROM public.profiles pe WHERE pe.id = e.editor_id)),
                 'approved_by', (SELECT pd.full_name FROM public.profiles pd WHERE pd.id = e.decided_by),
                 'reason', e.reason, 'decision_note', e.decision_note,
                 'old_outstanding', e.old_outstanding, 'new_outstanding', e.new_outstanding,
                 'reduction', CASE WHEN e.status = 'approved' THEN GREATEST(COALESCE(e.old_outstanding, 0) - COALESCE(e.new_outstanding, 0), 0) ELSE 0 END) a
          FROM public.tenant_balance_edits e WHERE e.rent_request_id = p_rent_request_id
        UNION ALL
        SELECT jsonb_build_object('at', l.created_at,
                 'kind', CASE l.edit_type WHEN 'outstanding_balance' THEN 'Outstanding balance edit (operations)' ELSE 'Rent amount edit (operations)' END,
                 'status', CASE WHEN l.reverted_on_dispute THEN 'reverted' ELSE COALESCE(l.resolution, l.agent_response, 'applied') END,
                 'by', COALESCE(l.edited_by_name, (SELECT pl.full_name FROM public.profiles pl WHERE pl.id = l.edited_by)),
                 'approved_by', l.resolved_by_name, 'reason', l.reason, 'decision_note', l.resolution_note,
                 'agent_response', l.agent_response, 'old_outstanding', l.old_amount, 'new_outstanding', COALESCE(l.final_amount, l.new_amount),
                 'reduction', CASE WHEN l.edit_type = 'outstanding_balance' AND NOT COALESCE(l.reverted_on_dispute, false)
                                   THEN GREATEST(COALESCE(l.old_amount, 0) - COALESCE(l.final_amount, l.new_amount, 0), 0) ELSE 0 END)
          FROM public.landlord_payment_edits l WHERE l.rent_request_id = p_rent_request_id
           -- a mirror of an approved tenant balance edit (same change, same moment) is listed once
           AND NOT EXISTS (SELECT 1 FROM public.tenant_balance_edits e
                            WHERE e.rent_request_id = l.rent_request_id AND e.status = 'approved'
                              AND abs(COALESCE(e.old_outstanding, 0) - COALESCE(l.old_amount, 0)) < 1
                              AND abs(COALESCE(e.new_outstanding, 0) - COALESCE(l.final_amount, l.new_amount, 0)) < 1
                              AND abs(extract(epoch FROM e.created_at - l.created_at)) < 600)
        UNION ALL
        SELECT jsonb_build_object('at', l.changed_at,
                 'kind', CASE WHEN l.source IS NOT NULL THEN 'Approved change (' || l.source || ')'
                              WHEN COALESCE(l.new_total_repayment, 0) <> COALESCE(l.old_total_repayment, 0) THEN 'Obligation changed'
                              ELSE 'Amount repaid changed with no receipt' END,
                 'status', 'applied', 'by', (SELECT pc.full_name FROM public.profiles pc WHERE pc.id = l.changed_by),
                 'old_total_repayment', l.old_total_repayment, 'new_total_repayment', l.new_total_repayment,
                 'old_amount_repaid', l.old_amount_repaid, 'new_amount_repaid', l.new_amount_repaid,
                 'after_funding', (v_funded IS NOT NULL AND l.changed_at > v_funded))
          FROM public.rent_amount_change_log l
         WHERE l.rent_request_id = p_rent_request_id
           AND (l.source IS NOT NULL
             OR COALESCE(l.new_total_repayment, 0) <> COALESCE(l.old_total_repayment, 0)
             OR (COALESCE(l.new_amount_repaid, 0) <> COALESCE(l.old_amount_repaid, 0)
                 AND NOT EXISTS (SELECT 1 FROM public.agent_collections c WHERE c.rent_request_id = l.rent_request_id
                                   AND c.amount = abs(COALESCE(l.new_amount_repaid, 0) - COALESCE(l.old_amount_repaid, 0))
                                   AND abs(extract(epoch FROM c.created_at - l.changed_at)) < 120)))
      ) z), '[]'::jsonb),
    -- the plan's ledger entries (rent / fee receivable, disbursement, collections), newest first
    'ledger', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('at', g.created_at, 'category', g.category, 'scope', g.ledger_scope, 'direction', g.direction,
               'amount', g.amount, 'group', g.transaction_group_id, 'reference', g.reference_id, 'description', left(g.description, 160))
             ORDER BY g.created_at DESC)
      FROM (SELECT gl.* FROM public.general_ledger gl
             WHERE gl.source_table IN ('rent_requests', 'agent_collections') AND gl.source_id = p_rent_request_id
               AND gl.ledger_scope IN ('platform', 'bridge')
             ORDER BY gl.created_at DESC LIMIT 1000) g), '[]'::jsonb));
END $function$;
REVOKE ALL ON FUNCTION public.get_cfo_tenant_repayment_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cfo_tenant_repayment_detail(uuid) TO authenticated, service_role;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261108120000';
COMMIT;
