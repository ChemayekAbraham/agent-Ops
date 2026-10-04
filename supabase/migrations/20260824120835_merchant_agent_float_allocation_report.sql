-- Merchant Agent Float Allocation Report
--
-- Ranks every active merchant (cash-out) agent on their withdrawal/payout
-- history so Financial Ops can decide who gets MORE float and who gets LESS.
--
-- Reuses the already-measured reliability backbone
-- (`merchant_payout_success_matrix`, ledger-verified: paid vs actually
-- customer-debited vs fully-recorded) and the ledger-truth float position
-- (`get_merchant_float_positions`) instead of re-deriving either from
-- scratch. Money figures come straight from `general_ledger` — never from
-- `withdrawal_requests.amount` alone or the cached `wallets.float_balance`.
CREATE OR REPLACE FUNCTION public.merchant_agent_float_allocation_report(p_days integer DEFAULT 30)
RETURNS TABLE (
  agent_id uuid,
  merchant_name text,
  merchant_phone text,
  label text,
  is_active boolean,
  is_online boolean,
  window_days integer,
  attempts bigint,
  actioned bigint,
  paid bigint,
  pct_paid numeric,
  pct_customer_debited numeric,
  pct_fully_recorded numeric,
  stranded_processing bigint,
  grade text,
  total_paid numeric,
  total_telecom numeric,
  total_float_consumed numeric,
  total_commission numeric,
  float_delivered numeric,
  float_turnover numeric,
  shortfall_count bigint,
  shortfall_amount numeric,
  pending_reimbursement_amount numeric,
  open_disputes bigint,
  ledger_float_held numeric,
  owed_to_agent numeric,
  company_cash_with_agent numeric,
  payouts_without_float_evidence bigint,
  max_daily_payouts integer,
  current_queue_count integer,
  capacity_utilization_pct numeric,
  allocation_score numeric,
  recommendation text,
  reason text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH bounds AS (
  SELECT now() - make_interval(days => GREATEST(p_days, 1)) AS start_at
),
matrix AS (
  SELECT * FROM public.merchant_payout_success_matrix(p_days)
),
money AS (
  SELECT
    gl.user_id AS agent_id,
    SUM(gl.amount) FILTER (
      WHERE gl.category = 'agent_float_settlement' AND gl.direction = 'cash_out'
        AND gl.reference_id NOT LIKE '%-merchant-telecom-charge'
    ) AS total_paid,
    SUM(gl.amount) FILTER (
      WHERE gl.category = 'agent_float_settlement' AND gl.direction = 'cash_out'
        AND gl.reference_id LIKE '%-merchant-telecom-charge'
    ) AS total_telecom,
    SUM(gl.amount) FILTER (
      WHERE gl.category = 'agent_float_settlement' AND gl.direction = 'cash_out'
    ) AS total_float_consumed,
    SUM(gl.amount) FILTER (
      WHERE gl.category = 'agent_commission_earned' AND gl.direction = 'cash_in'
    ) AS total_commission,
    SUM(gl.amount) FILTER (
      WHERE gl.category = 'agent_float_deposit' AND gl.direction = 'cash_in'
        AND gl.classification <> 'admin_correction'
    ) AS float_delivered
  FROM public.general_ledger gl
  CROSS JOIN bounds b
  WHERE gl.ledger_scope = 'wallet'
    AND gl.wallet_bucket = 'float'
    AND gl.transaction_date >= b.start_at
    AND gl.user_id IN (SELECT ca.agent_id FROM public.cashout_agents ca)
  GROUP BY gl.user_id
),
shortfalls AS (
  SELECT
    o.agent_id,
    COUNT(*) AS shortfall_count,
    SUM(o.shortfall_amount) AS shortfall_amount,
    SUM(o.shortfall_amount) FILTER (WHERE o.status = 'pending_reimbursement') AS pending_reimbursement_amount
  FROM public.merchant_out_of_pocket_advances o
  CROSS JOIN bounds b
  WHERE o.created_at >= b.start_at
    AND o.status IN ('needs_review', 'pending_reimbursement')
  GROUP BY o.agent_id
),
disputes AS (
  SELECT
    d.agent_id,
    COUNT(*) AS open_disputes
  FROM public.merchant_balance_disputes d
  CROSS JOIN bounds b
  WHERE d.created_at >= b.start_at
    AND d.status NOT IN ('resolved', 'rejected')
  GROUP BY d.agent_id
),
positions AS (
  SELECT gp.agent_id, gp.ledger_float_held, gp.owed_to_agent, gp.company_cash_with_agent, gp.payouts_without_float_evidence
  FROM public.get_merchant_float_positions() gp
),
base AS (
  SELECT
    ca.agent_id,
    COALESCE(p.full_name, ca.label, 'Unknown agent') AS merchant_name,
    p.phone AS merchant_phone,
    ca.label,
    ca.is_active,
    ca.is_online,
    ca.max_daily_payouts,
    ca.current_queue_count,
    COALESCE(m.attempts, 0) AS attempts,
    COALESCE(m.actioned, 0) AS actioned,
    COALESCE(m.paid, 0) AS paid,
    m.pct_paid,
    m.pct_customer_debited,
    m.pct_fully_recorded,
    COALESCE(m.stranded_processing, 0) AS stranded_processing,
    COALESCE(m.grade, 'no_payouts') AS grade,
    COALESCE(mo.total_paid, 0) AS total_paid,
    COALESCE(mo.total_telecom, 0) AS total_telecom,
    COALESCE(mo.total_float_consumed, 0) AS total_float_consumed,
    COALESCE(mo.total_commission, 0) AS total_commission,
    COALESCE(mo.float_delivered, 0) AS float_delivered,
    COALESCE(s.shortfall_count, 0) AS shortfall_count,
    COALESCE(s.shortfall_amount, 0) AS shortfall_amount,
    COALESCE(s.pending_reimbursement_amount, 0) AS pending_reimbursement_amount,
    COALESCE(d.open_disputes, 0) AS open_disputes,
    pos.ledger_float_held,
    pos.owed_to_agent,
    pos.company_cash_with_agent,
    pos.payouts_without_float_evidence
  FROM public.cashout_agents ca
  LEFT JOIN public.profiles p ON p.id = ca.agent_id
  LEFT JOIN matrix m ON m.merchant_id = ca.agent_id
  LEFT JOIN money mo ON mo.agent_id = ca.agent_id
  LEFT JOIN shortfalls s ON s.agent_id = ca.agent_id
  LEFT JOIN disputes d ON d.agent_id = ca.agent_id
  LEFT JOIN positions pos ON pos.agent_id = ca.agent_id
  WHERE ca.is_active
),
scored AS (
  SELECT
    base.*,
    CASE WHEN base.float_delivered > 0
      THEN ROUND(base.total_float_consumed / base.float_delivered, 2)
      ELSE NULL
    END AS float_turnover,
    CASE WHEN base.max_daily_payouts > 0
      THEN ROUND(100.0 * base.current_queue_count / base.max_daily_payouts, 1)
      ELSE NULL
    END AS capacity_utilization_pct,
    -- Reliability (0-50): the grade already accounts for whether payouts
    -- actually debited the customer and were fully recorded end to end.
    CASE base.grade
      WHEN 'healthy' THEN 50
      WHEN 'recording_gap' THEN 27
      WHEN 'money_risk' THEN 8
      WHEN 'stranded_claims' THEN 5
      ELSE 0
    END AS grade_pts,
    -- Settlement cleanliness (0-25)
    (COALESCE(base.pct_fully_recorded, 0) / 100.0) * 25 AS clean_pts,
    -- Correctness: real customer wallet debit behind the payout (0-15)
    (COALESCE(base.pct_customer_debited, 0) / 100.0) * 15 AS debit_pts,
    -- Float efficiency: how much of the float they were given actually
    -- cycled through customer payouts in the window (0-10, capped at 1.0x)
    LEAST(
      CASE WHEN base.float_delivered > 0
        THEN base.total_float_consumed / base.float_delivered
        ELSE 0
      END,
      1
    ) * 10 AS turnover_pts,
    LEAST(base.shortfall_count * 5, 20) AS shortfall_penalty,
    LEAST(base.open_disputes * 10, 20) AS dispute_penalty
  FROM base
),
final AS (
  SELECT
    scored.*,
    GREATEST(0, LEAST(100,
      scored.grade_pts + scored.clean_pts + scored.debit_pts + scored.turnover_pts
      - scored.shortfall_penalty - scored.dispute_penalty
    )) AS allocation_score
  FROM scored
)
SELECT
  final.agent_id,
  final.merchant_name,
  final.merchant_phone,
  final.label,
  final.is_active,
  final.is_online,
  GREATEST(p_days, 1) AS window_days,
  final.attempts,
  final.actioned,
  final.paid,
  final.pct_paid,
  final.pct_customer_debited,
  final.pct_fully_recorded,
  final.stranded_processing,
  final.grade,
  final.total_paid,
  final.total_telecom,
  final.total_float_consumed,
  final.total_commission,
  final.float_delivered,
  final.float_turnover,
  final.shortfall_count,
  final.shortfall_amount,
  final.pending_reimbursement_amount,
  final.open_disputes,
  final.ledger_float_held,
  final.owed_to_agent,
  final.company_cash_with_agent,
  final.payouts_without_float_evidence,
  final.max_daily_payouts,
  final.current_queue_count,
  final.capacity_utilization_pct,
  final.allocation_score,
  CASE
    WHEN final.attempts = 0 THEN 'insufficient_data'
    WHEN final.grade IN ('money_risk', 'stranded_claims') THEN 'reduce_or_freeze'
    WHEN final.allocation_score >= 75 THEN 'increase'
    WHEN final.allocation_score >= 45 THEN 'maintain'
    ELSE 'reduce_or_freeze'
  END AS recommendation,
  CASE
    WHEN final.attempts = 0 THEN
      'No payout attempts in the last ' || GREATEST(p_days, 1) || ' days — not enough data to size float.'
    WHEN final.grade = 'money_risk' THEN
      final.paid || ' paid payout(s) but only ' || COALESCE(final.pct_customer_debited, 0) || '% show a real customer wallet debit — money is at risk. Freeze float increases until resolved.'
    WHEN final.grade = 'stranded_claims' THEN
      final.stranded_processing || ' claimed payout(s) stuck in processing, tying up float without resolving. Freeze until cleared.'
    WHEN final.allocation_score >= 75 THEN
      'Grade ' || final.grade || ', ' || COALESCE(final.pct_fully_recorded, 0) || '% cleanly settled, float turnover ' || COALESCE(final.float_turnover::text, 'n/a') || 'x, ' || final.shortfall_count || ' shortfall(s), ' || final.open_disputes || ' open dispute(s) — strong candidate for more float.'
    WHEN final.allocation_score >= 45 THEN
      'Grade ' || final.grade || ', ' || COALESCE(final.pct_fully_recorded, 0) || '% cleanly settled — maintain current float level.'
    ELSE
      'Grade ' || final.grade || ', ' || COALESCE(final.pct_fully_recorded, 0) || '% cleanly settled, ' || final.shortfall_count || ' shortfall(s), ' || final.open_disputes || ' open dispute(s) — reduce or hold float until improved.'
  END AS reason
FROM final
ORDER BY final.allocation_score DESC NULLS LAST, final.total_paid DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.merchant_agent_float_allocation_report(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.merchant_agent_float_allocation_report(integer) TO service_role;
