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
    AND gl.direction = 'cash_out'
    AND (gl.transaction_date AT TIME ZONE 'Africa/Kampala')::date = p_date
  GROUP BY gl.user_id, gl.source_id
),
telecom AS (
  SELECT
    gl.user_id       AS agent_id,
    gl.source_id     AS withdrawal_id,
    SUM(gl.amount)   AS telecom_charge
  FROM general_ledger gl
  WHERE gl.reference_id LIKE '%-merchant-telecom-charge'
    AND gl.ledger_scope = 'wallet'
    AND gl.direction = 'cash_out'
    AND (gl.transaction_date AT TIME ZONE 'Africa/Kampala')::date = p_date
  GROUP BY gl.user_id, gl.source_id
),
payouts AS (
  SELECT
    c.agent_id,
    c.withdrawal_id,
    c.ts,
    c.commission,
    COALESCE(p.principal, c.commission * 200) AS principal,
    COALESCE(t.telecom_charge, 0)             AS telecom_charge
  FROM comm c
  LEFT JOIN principal p
    ON p.agent_id = c.agent_id AND p.withdrawal_id = c.withdrawal_id
  LEFT JOIN telecom t
    ON t.agent_id = c.agent_id AND t.withdrawal_id = c.withdrawal_id
),
enriched AS (
  SELECT
    po.*,
    (po.principal + po.telecom_charge) AS float_consumed,
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
    SUM(commission)                               AS total_commission,
    SUM(telecom_charge)                           AS total_telecom,
    SUM(principal + telecom_charge)               AS total_float_consumed
  FROM enriched
  GROUP BY agent_id
)
SELECT jsonb_build_object(
  'date', p_date,
  'merchant_count', (SELECT COUNT(*) FROM summary),
  'total_payouts', (SELECT COALESCE(SUM(payouts), 0) FROM summary),
  'total_paid', (SELECT COALESCE(SUM(total_paid), 0) FROM summary),
  'total_commission', (SELECT COALESCE(SUM(total_commission), 0) FROM summary),
  'total_telecom', (SELECT COALESCE(SUM(total_telecom), 0) FROM summary),
  'total_float_consumed', (SELECT COALESCE(SUM(total_float_consumed), 0) FROM summary),
  'summary', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'agent_id', agent_id,
      'merchant_name', merchant_name,
      'merchant_phone', merchant_phone,
      'payouts', payouts,
      'total_paid', total_paid,
      'total_commission', total_commission,
      'total_telecom', total_telecom,
      'total_float_consumed', total_float_consumed
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
      'telecom_charge', telecom_charge,
      'float_consumed', float_consumed,
      'payout_method', payout_method,
      'withdrawal_id', withdrawal_id
    ) ORDER BY ts ASC)
    FROM enriched
  ), '[]'::jsonb)
);
$$;

GRANT EXECUTE ON FUNCTION public.generate_merchant_cashout_daily_report(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.generate_merchant_cashout_daily_report(date) TO authenticated;