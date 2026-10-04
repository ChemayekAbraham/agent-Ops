-- Perf only: replace the two whole-platform wallet views in the merchant float
-- allocation report (v_merchant_float_position + v_merchant_float_ledger_variance,
-- ~6s each because both scan v_user_wallet_strict for every user) with the
-- per-user pivot helper wallet_strict_for_user, scoped to active cash-out desks.
-- Output values are byte-identical; only the plan changes.
CREATE OR REPLACE FUNCTION public.merchant_agent_float_allocation_report(p_days integer DEFAULT 30)
 RETURNS TABLE(agent_id uuid, merchant_name text, merchant_phone text, label text, channels text, is_active boolean, is_online boolean, window_days integer, attempts bigint, actioned bigint, paid bigint, payouts_verified bigint, pct_paid numeric, pct_customer_debited numeric, pct_fully_recorded numeric, stranded_processing bigint, grade text, total_paid numeric, total_telecom numeric, total_float_consumed numeric, total_commission numeric, commission_awards bigint, float_delivered numeric, float_turnover numeric, shortfall_count bigint, shortfall_amount numeric, needs_review_count bigint, needs_review_amount numeric, pending_reimbursement_count bigint, pending_reimbursement_amount numeric, open_disputes bigint, float_cache numeric, float_ledger numeric, float_spendable numeric, reserved_float numeric, available_float numeric, out_of_pocket_outstanding numeric, net_position numeric, state text, settlement_clean_pct numeric, settled_count bigint, unsettled_count bigint, failed_settlements bigint, max_daily_payouts integer, current_queue_count integer, capacity_utilization_pct numeric, allocation_score numeric, recommendation text, reason text, blocker text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH guard AS (SELECT public.assert_merchant_float_alloc_access() AS ok),
bounds AS (SELECT now() - make_interval(days => GREATEST(p_days, 1)) AS start_at),
matrix AS (SELECT * FROM public.merchant_payout_success_matrix(p_days)),
wr AS (
  SELECT
    wr.id,
    COALESCE(wr.processing_started_by, wr.dispatch_claimed_by, wr.processed_by) AS actor,
    wr.settlement_state
  FROM public.withdrawal_requests wr
  CROSS JOIN bounds b
  CROSS JOIN guard
  WHERE wr.created_at >= b.start_at
    AND wr.status IN ('paid', 'completed')
    AND COALESCE(wr.processing_started_by, wr.dispatch_claimed_by, wr.processed_by)
        IN (SELECT ca.agent_id FROM public.cashout_agents ca)
),
legs AS (
  SELECT
    wr.id AS withdrawal_id,
    SUM(g.amount) FILTER (
      WHERE g.direction = 'cash_out'
        AND g.category IN ('wallet_withdrawal', 'agent_commission_withdrawal')) AS customer_debit,
    SUM(g.amount) FILTER (
      WHERE g.direction = 'cash_out' AND g.wallet_bucket = 'float'
        AND g.category = 'agent_float_settlement'
        AND COALESCE(g.reference_id, '') NOT LIKE '%-merchant-telecom-charge') AS float_principal,
    SUM(g.amount) FILTER (
      WHERE g.direction = 'cash_out' AND g.wallet_bucket = 'float'
        AND g.category = 'agent_float_settlement'
        AND COALESCE(g.reference_id, '') LIKE '%-merchant-telecom-charge') AS float_telecom
  FROM wr
  JOIN public.general_ledger g ON g.source_id = wr.id AND g.ledger_scope = 'wallet'
  GROUP BY wr.id
),
money AS (
  SELECT
    wr.actor AS agent_id,
    COUNT(*) FILTER (WHERE COALESCE(l.customer_debit, 0) > 0) AS payouts_verified,
    COALESCE(SUM(l.customer_debit), 0) AS total_paid,
    COALESCE(SUM(l.float_telecom), 0) AS total_telecom,
    COALESCE(SUM(COALESCE(l.float_principal, 0) + COALESCE(l.float_telecom, 0)), 0) AS total_float_consumed,
    COUNT(*) FILTER (WHERE wr.settlement_state = 'settled') AS settled_count,
    COUNT(*) FILTER (WHERE wr.settlement_state IN ('unsettled', 'pending', 'processing')) AS unsettled_count,
    COUNT(*) FILTER (WHERE wr.settlement_state = 'failed') AS failed_settlements
  FROM wr
  LEFT JOIN legs l ON l.withdrawal_id = wr.id
  GROUP BY wr.actor
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
  WHERE d.created_at >= b.start_at AND d.status NOT IN ('resolved', 'rejected')
  GROUP BY d.agent_id
),
-- Per-agent float position: same arithmetic as v_merchant_float_position and
-- v_merchant_float_ledger_variance, but computed only for active desks.
desks AS (
  SELECT DISTINCT ca.agent_id
  FROM public.cashout_agents ca
  CROSS JOIN guard
  WHERE ca.is_active
),
positions AS (
  SELECT
    d.agent_id,
    mrf.reserved,
    COALESCE(oop.pending, 0) + COALESCE(oop.under_review, 0) AS owed_total,
    ws.float_balance_signed - mrf.reserved
      - COALESCE(oop.pending, 0) - COALESCE(oop.under_review, 0) AS net_position,
    CASE
      WHEN ws.float_balance_signed - mrf.reserved
           - COALESCE(oop.pending, 0) - COALESCE(oop.under_review, 0) < 0 THEN 'OWED'
      ELSE 'FUNDED'
    END AS state,
    GREATEST(COALESCE(w.float_balance, 0), 0) AS stored_float,
    ws.float_balance AS ledger_float,
    LEAST(GREATEST(COALESCE(w.float_balance, 0), 0), COALESCE(ws.float_balance, 0)) AS spendable_float
  FROM desks d
  CROSS JOIN LATERAL public.wallet_strict_for_user(d.agent_id) ws
  CROSS JOIN LATERAL (SELECT public.merchant_reserved_float(d.agent_id) AS reserved) mrf
  LEFT JOIN public.wallets w ON w.user_id = d.agent_id
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(SUM(o.shortfall_amount) FILTER (WHERE o.status = 'pending_reimbursement'), 0) AS pending,
      COALESCE(SUM(o.shortfall_amount) FILTER (WHERE o.status = 'needs_review'), 0) AS under_review
    FROM public.merchant_out_of_pocket_advances o
    WHERE o.agent_id = d.agent_id AND o.reimbursed_at IS NULL
  ) oop ON true
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
      CASE WHEN ca.handles_airtel THEN 'Airtel' END), '') AS channels,
    ca.is_active, ca.is_online, ca.max_daily_payouts, ca.current_queue_count,
    COALESCE(m.attempts, 0) AS attempts,
    COALESCE(m.actioned, 0) AS actioned,
    COALESCE(m.paid, 0) AS paid,
    COALESCE(mo.payouts_verified, 0) AS payouts_verified,
    m.pct_paid, m.pct_customer_debited, m.pct_fully_recorded,
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
  SELECT base.*,
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
  SELECT derived.*,
    CASE derived.grade
      WHEN 'healthy' THEN 50 WHEN 'recording_gap' THEN 27
      WHEN 'money_risk' THEN 8 WHEN 'stranded_claims' THEN 5 ELSE 0 END AS grade_pts,
    (COALESCE(derived.settlement_clean_pct, 0) / 100.0) * 25 AS clean_pts,
    (COALESCE(derived.pct_customer_debited, 0) / 100.0) * 15 AS debit_pts,
    LEAST(CASE WHEN derived.float_delivered > 0
      THEN derived.total_float_consumed / derived.float_delivered ELSE 0 END, 1) * 10 AS turnover_pts,
    LEAST(derived.needs_review_count * 6 + derived.pending_reimbursement_count * 2, 20) AS shortfall_penalty,
    LEAST(derived.open_disputes * 10, 20) AS dispute_penalty,
    LEAST(derived.failed_settlements * 5, 15) AS settlement_penalty
  FROM derived
),
final AS (
  SELECT scored.*,
    GREATEST(0, LEAST(100,
      scored.grade_pts + scored.clean_pts + scored.debit_pts + scored.turnover_pts
      - scored.shortfall_penalty - scored.dispute_penalty - scored.settlement_penalty)) AS allocation_score,
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