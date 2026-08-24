-- Access guard: restrict the merchant float allocation report to finance/exec roles,
-- mirroring the RLS pattern on merchant_payout_success_runs.
CREATE OR REPLACE FUNCTION public.assert_merchant_float_alloc_access()
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF public.has_role(auth.uid(), 'cfo')
     OR public.has_role(auth.uid(), 'financial_ops')
     OR public.has_role(auth.uid(), 'coo')
     OR public.has_role(auth.uid(), 'manager')
     OR public.has_role(auth.uid(), 'super_admin') THEN
    RETURN true;
  END IF;
  RAISE EXCEPTION 'Not authorized: merchant float allocation is restricted to CFO, Financial Ops, COO, manager and super admin';
END;
$$;

REVOKE ALL ON FUNCTION public.assert_merchant_float_alloc_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_merchant_float_alloc_access() TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_merchant_float_alloc_access() TO service_role;

DROP FUNCTION IF EXISTS public.merchant_agent_float_allocation_report(integer);

CREATE FUNCTION public.merchant_agent_float_allocation_report(p_days integer DEFAULT 30)
RETURNS TABLE(
  agent_id uuid,
  merchant_name text,
  merchant_phone text,
  label text,
  channels text,
  is_active boolean,
  is_online boolean,
  window_days integer,
  attempts bigint,
  actioned bigint,
  paid bigint,
  payouts_verified bigint,
  pct_paid numeric,
  pct_customer_debited numeric,
  pct_fully_recorded numeric,
  stranded_processing bigint,
  grade text,
  total_paid numeric,
  total_telecom numeric,
  total_float_consumed numeric,
  total_commission numeric,
  commission_awards bigint,
  float_delivered numeric,
  float_turnover numeric,
  shortfall_count bigint,
  shortfall_amount numeric,
  needs_review_count bigint,
  needs_review_amount numeric,
  pending_reimbursement_count bigint,
  pending_reimbursement_amount numeric,
  open_disputes bigint,
  float_cache numeric,
  float_ledger numeric,
  float_spendable numeric,
  reserved_float numeric,
  available_float numeric,
  out_of_pocket_outstanding numeric,
  net_position numeric,
  state text,
  settlement_clean_pct numeric,
  settled_count bigint,
  unsettled_count bigint,
  failed_settlements bigint,
  max_daily_payouts integer,
  current_queue_count integer,
  capacity_utilization_pct numeric,
  allocation_score numeric,
  recommendation text,
  reason text,
  blocker text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
WITH guard AS (SELECT public.assert_merchant_float_alloc_access() AS ok),
bounds AS (
  SELECT now() - make_interval(days => GREATEST(p_days, 1)) AS start_at
),
matrix AS (
  SELECT * FROM public.merchant_payout_success_matrix(p_days)
),
wr AS (
  SELECT
    wr.id,
    COALESCE(wr.processing_started_by, wr.dispatch_claimed_by, wr.processed_by) AS actor,
    wr.status,
    wr.settlement_state
  FROM public.withdrawal_requests wr
  CROSS JOIN bounds b
  CROSS JOIN guard
  WHERE wr.created_at >= b.start_at
    AND wr.status IN ('paid', 'completed')
    AND COALESCE(wr.processing_started_by, wr.dispatch_claimed_by, wr.processed_by)
        IN (SELECT ca.agent_id FROM public.cashout_agents ca)
),
wr_money AS (
  SELECT
    wr.actor AS agent_id,
    wr.id AS withdrawal_id,
    wr.settlement_state,
    COALESCE((
      SELECT SUM(g.amount) FROM public.general_ledger g
      WHERE g.source_id = wr.id AND g.ledger_scope = 'wallet' AND g.direction = 'cash_out'
        AND g.category IN ('wallet_withdrawal', 'agent_commission_withdrawal')
    ), 0) AS customer_debit,
    COALESCE((
      SELECT SUM(g.amount) FROM public.general_ledger g
      WHERE g.source_id = wr.id AND g.ledger_scope = 'wallet' AND g.wallet_bucket = 'float'
        AND g.direction = 'cash_out' AND g.category = 'agent_float_settlement'
        AND COALESCE(g.reference_id, '') NOT LIKE '%-merchant-telecom-charge'
    ), 0) AS float_principal,
    COALESCE((
      SELECT SUM(g.amount) FROM public.general_ledger g
      WHERE g.source_id = wr.id AND g.ledger_scope = 'wallet' AND g.wallet_bucket = 'float'
        AND g.direction = 'cash_out' AND g.category = 'agent_float_settlement'
        AND COALESCE(g.reference_id, '') LIKE '%-merchant-telecom-charge'
    ), 0) AS float_telecom
  FROM wr
),
money AS (
  SELECT
    m.agent_id,
    COUNT(*) FILTER (WHERE m.customer_debit > 0) AS payouts_verified,
    SUM(m.customer_debit) AS total_paid,
    SUM(m.float_principal) AS float_principal,
    SUM(m.float_telecom) AS total_telecom,
    SUM(m.float_principal + m.float_telecom) AS total_float_consumed,
    COUNT(*) FILTER (WHERE m.settlement_state = 'settled') AS settled_count,
    COUNT(*) FILTER (WHERE m.settlement_state IN ('unsettled', 'pending', 'processing')) AS unsettled_count,
    COUNT(*) FILTER (WHERE m.settlement_state = 'failed') AS failed_settlements
  FROM wr_money m
  GROUP BY m.agent_id
),
commission AS (
  SELECT c.agent_id, COUNT(*) AS commission_awards, SUM(c.commission_amount) AS total_commission
  FROM public.merchant_commission_awards c
  CROSS JOIN bounds b
  WHERE c.created_at >= b.start_at
  GROUP BY c.agent_id
),
deliveries AS (
  SELECT d.agent_user_id AS agent_id, SUM(d.amount) AS float_delivered
  FROM public.merchant_float_deliveries d
  CROSS JOIN bounds b
  WHERE d.occurred_at >= b.start_at
  GROUP BY d.agent_user_id
),
shortfalls AS (
  SELECT
    o.agent_id,
    COUNT(*) AS shortfall_count,
    SUM(o.shortfall_amount) AS shortfall_amount,
    COUNT(*) FILTER (WHERE o.status = 'needs_review') AS needs_review_count,
    SUM(o.shortfall_amount) FILTER (WHERE o.status = 'needs_review') AS needs_review_amount,
    COUNT(*) FILTER (WHERE o.status = 'pending_reimbursement') AS pending_reimbursement_count,
    SUM(o.shortfall_amount) FILTER (WHERE o.status = 'pending_reimbursement') AS pending_reimbursement_amount
  FROM public.merchant_out_of_pocket_advances o
  CROSS JOIN bounds b
  WHERE o.created_at >= b.start_at
    AND o.status IN ('needs_review', 'pending_reimbursement')
  GROUP BY o.agent_id
),
disputes AS (
  SELECT d.agent_id, COUNT(*) AS open_disputes
  FROM public.merchant_balance_disputes d
  CROSS JOIN bounds b
  WHERE d.created_at >= b.start_at
    AND d.status NOT IN ('resolved', 'rejected')
  GROUP BY d.agent_id
),
positions AS (
  SELECT
    pos.agent_id,
    pos.reserved,
    pos.own_cash_outstanding + pos.own_cash_under_review AS owed_total,
    pos.net_position,
    pos.state,
    var.stored_float,
    var.ledger_float,
    LEAST(COALESCE(var.stored_float, 0), COALESCE(var.ledger_float, 0)) AS spendable_float
  FROM public.v_merchant_float_position pos
  LEFT JOIN public.v_merchant_float_ledger_variance var ON var.agent_id = pos.agent_id
),
base AS (
  SELECT
    ca.agent_id,
    COALESCE(p.full_name, ca.label, 'Unknown agent') AS merchant_name,
    p.phone AS merchant_phone,
    ca.label,
    NULLIF(concat_ws(' · ',
      CASE WHEN ca.handles_cash THEN 'Cash' END,
      CASE WHEN ca.handles_bank THEN 'Bank' END,
      CASE WHEN ca.handles_mtn THEN 'MTN' END,
      CASE WHEN ca.handles_airtel THEN 'Airtel' END
    ), '') AS channels,
    ca.is_active,
    ca.is_online,
    ca.max_daily_payouts,
    ca.current_queue_count,
    COALESCE(m.attempts, 0) AS attempts,
    COALESCE(m.actioned, 0) AS actioned,
    COALESCE(m.paid, 0) AS paid,
    COALESCE(mo.payouts_verified, 0) AS payouts_verified,
    m.pct_paid,
    m.pct_customer_debited,
    m.pct_fully_recorded,
    COALESCE(m.stranded_processing, 0) AS stranded_processing,
    COALESCE(m.grade, 'no_payouts') AS grade,
    COALESCE(mo.total_paid, 0) AS total_paid,
    COALESCE(mo.total_telecom, 0) AS total_telecom,
    COALESCE(mo.total_float_consumed, 0) AS total_float_consumed,
    COALESCE(cm.total_commission, 0) AS total_commission,
    COALESCE(cm.commission_awards, 0) AS commission_awards,
    COALESCE(dl.float_delivered, 0) AS float_delivered,
    COALESCE(s.shortfall_count, 0) AS shortfall_count,
    COALESCE(s.shortfall_amount, 0) AS shortfall_amount,
    COALESCE(s.needs_review_count, 0) AS needs_review_count,
    COALESCE(s.needs_review_amount, 0) AS needs_review_amount,
    COALESCE(s.pending_reimbursement_count, 0) AS pending_reimbursement_count,
    COALESCE(s.pending_reimbursement_amount, 0) AS pending_reimbursement_amount,
    COALESCE(d.open_disputes, 0) AS open_disputes,
    COALESCE(pos.stored_float, 0) AS float_cache,
    COALESCE(pos.ledger_float, 0) AS float_ledger,
    COALESCE(pos.spendable_float, 0) AS float_spendable,
    COALESCE(pos.reserved, 0) AS reserved_float,
    GREATEST(COALESCE(pos.spendable_float, 0) - COALESCE(pos.reserved, 0), 0) AS available_float,
    COALESCE(pos.owed_total, 0) AS out_of_pocket_outstanding,
    COALESCE(pos.net_position, 0) AS net_position,
    COALESCE(pos.state, 'FUNDED') AS state,
    COALESCE(mo.settled_count, 0) AS settled_count,
    COALESCE(mo.unsettled_count, 0) AS unsettled_count,
    COALESCE(mo.failed_settlements, 0) AS failed_settlements
  FROM public.cashout_agents ca
  CROSS JOIN guard
  LEFT JOIN public.profiles p ON p.id = ca.agent_id
  LEFT JOIN matrix m ON m.merchant_id = ca.agent_id
  LEFT JOIN money mo ON mo.agent_id = ca.agent_id
  LEFT JOIN commission cm ON cm.agent_id = ca.agent_id
  LEFT JOIN deliveries dl ON dl.agent_id = ca.agent_id
  LEFT JOIN shortfalls s ON s.agent_id = ca.agent_id
  LEFT JOIN disputes d ON d.agent_id = ca.agent_id
  LEFT JOIN positions pos ON pos.agent_id = ca.agent_id
  WHERE ca.is_active
),
derived AS (
  SELECT
    base.*,
    CASE WHEN base.float_delivered > 0
      THEN ROUND(base.total_float_consumed / base.float_delivered, 2) END AS float_turnover,
    CASE WHEN (base.settled_count + base.unsettled_count + base.failed_settlements) > 0
      THEN ROUND(100.0 * base.settled_count
                 / (base.settled_count + base.unsettled_count + base.failed_settlements), 1) END AS settlement_clean_pct,
    CASE WHEN COALESCE(base.max_daily_payouts, 0) > 0
      THEN ROUND(100.0 * base.paid / (base.max_daily_payouts * GREATEST(p_days, 1)), 1) END AS capacity_utilization_pct
  FROM base
),
scored AS (
  SELECT
    derived.*,
    CASE derived.grade
      WHEN 'healthy' THEN 50
      WHEN 'recording_gap' THEN 27
      WHEN 'money_risk' THEN 8
      WHEN 'stranded_claims' THEN 5
      ELSE 0
    END AS grade_pts,
    (COALESCE(derived.settlement_clean_pct, 0) / 100.0) * 25 AS clean_pts,
    (COALESCE(derived.pct_customer_debited, 0) / 100.0) * 15 AS debit_pts,
    LEAST(
      CASE WHEN derived.float_delivered > 0
        THEN derived.total_float_consumed / derived.float_delivered ELSE 0 END, 1) * 10 AS turnover_pts,
    LEAST(derived.needs_review_count * 6 + derived.pending_reimbursement_count * 2, 20) AS shortfall_penalty,
    LEAST(derived.open_disputes * 10, 20) AS dispute_penalty,
    LEAST(derived.failed_settlements * 5, 15) AS settlement_penalty
  FROM derived
),
final AS (
  SELECT
    scored.*,
    GREATEST(0, LEAST(100,
      scored.grade_pts + scored.clean_pts + scored.debit_pts + scored.turnover_pts
      - scored.shortfall_penalty - scored.dispute_penalty - scored.settlement_penalty
    )) AS allocation_score,
    CASE
      WHEN scored.state = 'OWED' AND scored.open_disputes > 0 THEN
        'Blocked: desk is in state OWED (net ' || ROUND(scored.net_position) || ') with '
        || scored.open_disputes || ' unresolved balance dispute(s). Resolve before any float increase.'
      WHEN scored.grade IN ('money_risk', 'stranded_claims') THEN
        'Blocked: reliability grade ' || scored.grade || ' — payout money trail is not proven.'
      WHEN scored.float_cache > scored.float_ledger THEN
        'Cache drift: stored float ' || ROUND(scored.float_cache) || ' exceeds ledger float '
        || ROUND(scored.float_ledger) || '. Spendable float clamped to the ledger figure.'
    END AS blocker
  FROM scored
)
SELECT
  final.agent_id, final.merchant_name, final.merchant_phone, final.label, final.channels,
  final.is_active, final.is_online, GREATEST(p_days, 1) AS window_days,
  final.attempts, final.actioned, final.paid, final.payouts_verified,
  final.pct_paid, final.pct_customer_debited, final.pct_fully_recorded,
  final.stranded_processing, final.grade,
  final.total_paid, final.total_telecom, final.total_float_consumed,
  final.total_commission, final.commission_awards,
  final.float_delivered, final.float_turnover,
  final.shortfall_count, final.shortfall_amount,
  final.needs_review_count, final.needs_review_amount,
  final.pending_reimbursement_count, final.pending_reimbursement_amount,
  final.open_disputes,
  final.float_cache, final.float_ledger, final.float_spendable,
  final.reserved_float, final.available_float, final.out_of_pocket_outstanding,
  final.net_position, final.state,
  final.settlement_clean_pct, final.settled_count, final.unsettled_count, final.failed_settlements,
  final.max_daily_payouts, final.current_queue_count, final.capacity_utilization_pct,
  final.allocation_score,
  CASE
    WHEN final.attempts = 0 THEN 'insufficient_data'
    WHEN final.grade IN ('money_risk', 'stranded_claims') THEN 'reduce_or_freeze'
    WHEN final.state = 'OWED' AND final.open_disputes > 0 THEN 'reduce_or_freeze'
    WHEN final.allocation_score >= 75 THEN 'increase'
    WHEN final.allocation_score >= 45 THEN 'maintain'
    ELSE 'reduce_or_freeze'
  END AS recommendation,
  CASE
    WHEN final.attempts = 0 THEN
      'No payout attempts in the last ' || GREATEST(p_days, 1) || ' days — not enough history to size float.'
    WHEN final.grade = 'money_risk' THEN
      final.paid || ' payout(s) marked paid but only ' || COALESCE(final.pct_customer_debited, 0)
      || '% carry a real customer wallet debit leg — money at risk. Freeze float increases until resolved.'
    WHEN final.grade = 'stranded_claims' THEN
      final.stranded_processing || ' claimed payout(s) stuck in processing, tying up float without resolving. Freeze until cleared.'
    WHEN final.state = 'OWED' AND final.open_disputes > 0 THEN
      'Desk is OWED (net ' || ROUND(final.net_position) || ') with ' || final.open_disputes
      || ' open dispute(s) — settle the position before adding float.'
    WHEN final.allocation_score >= 75 THEN
      'grade=' || final.grade || ', ' || COALESCE(final.settlement_clean_pct, 0)
      || '% clean settlement, turnover ' || COALESCE(final.float_turnover::text, 'n/a') || 'x, '
      || final.needs_review_count || ' shortfall(s) under review, ' || final.open_disputes
      || ' dispute(s), capacity ' || COALESCE(final.capacity_utilization_pct::text, 'n/a')
      || '% → increase float.'
    WHEN final.allocation_score >= 45 THEN
      'grade=' || final.grade || ', ' || COALESCE(final.settlement_clean_pct, 0)
      || '% clean settlement, turnover ' || COALESCE(final.float_turnover::text, 'n/a')
      || 'x → maintain current float level.'
    ELSE
      'grade=' || final.grade || ', ' || COALESCE(final.settlement_clean_pct, 0)
      || '% clean settlement, ' || final.shortfall_count || ' shortfall(s), '
      || final.open_disputes || ' open dispute(s) → reduce or hold float until improved.'
  END AS reason,
  final.blocker
FROM final
ORDER BY final.allocation_score DESC NULLS LAST, final.total_paid DESC NULLS LAST;
$function$;

REVOKE ALL ON FUNCTION public.merchant_agent_float_allocation_report(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merchant_agent_float_allocation_report(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.merchant_agent_float_allocation_report(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.merchant_agent_float_allocation_evidence(
  p_agent_id uuid,
  p_days integer DEFAULT 30
)
RETURNS TABLE(
  withdrawal_id uuid,
  created_at timestamptz,
  status text,
  settlement_state text,
  request_amount numeric,
  customer_debit numeric,
  float_principal numeric,
  float_telecom numeric,
  commission_amount numeric,
  has_debit_leg boolean,
  has_funding_record boolean,
  has_commission_award boolean,
  shortfall_amount numeric,
  shortfall_kind text,
  shortfall_status text,
  ledger_leg_ids uuid[]
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
WITH guard AS (SELECT public.assert_merchant_float_alloc_access() AS ok),
b AS (SELECT now() - make_interval(days => GREATEST(p_days, 1)) AS start_at)
SELECT
  wr.id,
  wr.created_at,
  wr.status,
  wr.settlement_state,
  wr.amount,
  COALESCE(l.customer_debit, 0),
  COALESCE(l.float_principal, 0),
  COALESCE(l.float_telecom, 0),
  COALESCE(c.commission_amount, 0),
  COALESCE(l.customer_debit, 0) > 0,
  EXISTS (SELECT 1 FROM public.merchant_payout_funding f WHERE f.withdrawal_id = wr.id),
  c.id IS NOT NULL,
  COALESCE(o.shortfall_amount, 0),
  o.kind,
  o.status,
  COALESCE(l.leg_ids, ARRAY[]::uuid[])
FROM public.withdrawal_requests wr
CROSS JOIN b
CROSS JOIN guard
LEFT JOIN LATERAL (
  SELECT
    SUM(g.amount) FILTER (
      WHERE g.direction = 'cash_out'
        AND g.category IN ('wallet_withdrawal', 'agent_commission_withdrawal')) AS customer_debit,
    SUM(g.amount) FILTER (
      WHERE g.direction = 'cash_out' AND g.category = 'agent_float_settlement'
        AND COALESCE(g.reference_id, '') NOT LIKE '%-merchant-telecom-charge') AS float_principal,
    SUM(g.amount) FILTER (
      WHERE g.direction = 'cash_out' AND g.category = 'agent_float_settlement'
        AND COALESCE(g.reference_id, '') LIKE '%-merchant-telecom-charge') AS float_telecom,
    ARRAY_AGG(g.id) AS leg_ids
  FROM public.general_ledger g
  WHERE g.source_id = wr.id AND g.ledger_scope = 'wallet'
) l ON true
LEFT JOIN public.merchant_commission_awards c ON c.withdrawal_id = wr.id
LEFT JOIN public.merchant_out_of_pocket_advances o ON o.withdrawal_id = wr.id
WHERE wr.created_at >= b.start_at
  AND COALESCE(wr.processing_started_by, wr.dispatch_claimed_by, wr.processed_by) = p_agent_id
  AND wr.status IN ('paid', 'completed')
ORDER BY wr.created_at DESC
LIMIT 500;
$function$;

REVOKE ALL ON FUNCTION public.merchant_agent_float_allocation_evidence(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merchant_agent_float_allocation_evidence(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.merchant_agent_float_allocation_evidence(uuid, integer) TO service_role;