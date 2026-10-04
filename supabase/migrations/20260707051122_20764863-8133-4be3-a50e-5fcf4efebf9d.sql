-- Daily report of individual merchant (cash-out) agent payouts.
-- Aggregates directly from the immutable general_ledger so figures are accurate.
--
-- Per merchant-settled cash payout, approve-withdrawal posts:
--   * a 0.5% commission leg  (reference '<wd>-cashout-commission', wallet cash_in) -- ALWAYS present
--   * a principal leg        (reference '<wd>-merchant-float-consume' [float model]
--                             or '<wd>-merchant-reimbursement' [legacy model], wallet)
-- The commission leg is the canonical per-payout marker (covers both models);
-- the principal is read from the paired principal leg (fallback: commission * 200).
--
-- Day boundary is anchored to Africa/Kampala (EAT, UTC+3, no DST) so "today"
-- matches what merchants experience on the ground.
CREATE OR REPLACE FUNCTION public.generate_merchant_cashout_daily_report(p_date date)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH comm AS (
  SELECT
    gl.user_id                       AS agent_id,
    gl.source_id                     AS withdrawal_id,
    SUM(gl.amount)                   AS commission,
    MIN(gl.transaction_date)         AS ts
  FROM general_ledger gl
  WHERE gl.reference_id LIKE '%-cashout-commission'
    AND gl.ledger_scope = 'wallet'
    AND gl.direction = 'cash_in'
    AND gl.category = 'agent_commission_earned'
    AND (gl.transaction_date AT TIME ZONE 'Africa/Kampala')::date = p_date
  GROUP BY gl.user_id, gl.source_id
),
principal AS (
  SELECT
    gl.user_id       AS agent_id,
    gl.source_id     AS withdrawal_id,
    SUM(gl.amount)   AS principal
  FROM general_ledger gl
  WHERE (gl.reference_id LIKE '%-merchant-float-consume'
         OR gl.reference_id LIKE '%-merchant-reimbursement')
    AND gl.ledger_scope = 'wallet'
    AND (gl.transaction_date AT TIME ZONE 'Africa/Kampala')::date = p_date
  GROUP BY gl.user_id, gl.source_id
),
payouts AS (
  SELECT
    c.agent_id,
    c.withdrawal_id,
    c.ts,
    c.commission,
    COALESCE(p.principal, c.commission * 200) AS principal
  FROM comm c
  LEFT JOIN principal p
    ON p.agent_id = c.agent_id AND p.withdrawal_id = c.withdrawal_id
),
enriched AS (
  SELECT
    po.*,
    mp.full_name AS merchant_name,
    mp.phone     AS merchant_phone,
    cp.full_name AS customer_name,
    wr.payout_method
  FROM payouts po
  LEFT JOIN profiles mp ON mp.id = po.agent_id
  LEFT JOIN withdrawal_requests wr ON wr.id = po.withdrawal_id
  LEFT JOIN profiles cp ON cp.id = wr.user_id
),
summary AS (
  SELECT
    agent_id,
    COALESCE(MAX(merchant_name), 'Unknown agent') AS merchant_name,
    MAX(merchant_phone)                           AS merchant_phone,
    COUNT(*)                                       AS payouts,
    SUM(principal)                                 AS total_paid,
    SUM(commission)                               AS total_commission
  FROM enriched
  GROUP BY agent_id
)
SELECT jsonb_build_object(
  'date', p_date,
  'merchant_count', (SELECT COUNT(*) FROM summary),
  'total_payouts', (SELECT COALESCE(SUM(payouts), 0) FROM summary),
  'total_paid', (SELECT COALESCE(SUM(total_paid), 0) FROM summary),
  'total_commission', (SELECT COALESCE(SUM(total_commission), 0) FROM summary),
  'summary', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'agent_id', agent_id,
      'merchant_name', merchant_name,
      'merchant_phone', merchant_phone,
      'payouts', payouts,
      'total_paid', total_paid,
      'total_commission', total_commission
    ) ORDER BY total_paid DESC)
    FROM summary
  ), '[]'::jsonb),
  'detail', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'time', to_char(ts AT TIME ZONE 'Africa/Kampala', 'HH24:MI'),
      'merchant_name', merchant_name,
      'merchant_phone', merchant_phone,
      'customer_name', customer_name,
      'amount', principal,
      'commission', commission,
      'payout_method', payout_method,
      'withdrawal_id', withdrawal_id
    ) ORDER BY ts ASC)
    FROM enriched
  ), '[]'::jsonb)
);
$$;

GRANT EXECUTE ON FUNCTION public.generate_merchant_cashout_daily_report(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.generate_merchant_cashout_daily_report(date) TO authenticated;