CREATE OR REPLACE FUNCTION public.generate_merchant_cashout_daily_report(p_date date)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
WITH day_bounds AS (
  SELECT
    p_date::timestamp AT TIME ZONE 'Africa/Kampala' AS start_at,
    (p_date::timestamp + interval '1 day') AT TIME ZONE 'Africa/Kampala' AS end_at
),
posted_wallet_payouts AS (
  SELECT
    gl.source_id AS withdrawal_id,
    SUM(gl.amount)::numeric AS principal,
    MIN(gl.transaction_date) AS ts
  FROM public.general_ledger gl
  CROSS JOIN day_bounds b
  WHERE gl.source_table = 'withdrawal_requests'
    AND gl.source_id IS NOT NULL
    AND gl.classification = 'production'
    AND gl.ledger_scope = 'wallet'
    AND gl.direction = 'cash_out'
    AND gl.category = 'wallet_withdrawal'
    AND gl.transaction_date >= b.start_at
    AND gl.transaction_date < b.end_at
  GROUP BY gl.source_id
),
comm AS (
  SELECT
    gl.source_id AS withdrawal_id,
    SUM(gl.amount)::numeric AS commission
  FROM public.general_ledger gl
  CROSS JOIN day_bounds b
  WHERE gl.reference_id LIKE '%-cashout-commission'
    AND gl.ledger_scope = 'wallet'
    AND gl.direction = 'cash_in'
    AND gl.category = 'agent_commission_earned'
    AND gl.transaction_date >= b.start_at
    AND gl.transaction_date < b.end_at
  GROUP BY gl.source_id
),
telecom AS (
  SELECT
    gl.source_id AS withdrawal_id,
    SUM(gl.amount)::numeric AS telecom_charge
  FROM public.general_ledger gl
  CROSS JOIN day_bounds b
  WHERE gl.reference_id LIKE '%-merchant-telecom-charge'
    AND gl.ledger_scope = 'wallet'
    AND gl.direction = 'cash_out'
    AND gl.transaction_date >= b.start_at
    AND gl.transaction_date < b.end_at
  GROUP BY gl.source_id
),
payouts AS (
  SELECT
    COALESCE(
      wr.assigned_cashout_agent_id,
      wr.dispatch_claimed_by,
      wr.fin_ops_approved_by,
      wr.processed_by,
      merchant_comm_agent.agent_id,
      merchant_float_agent.agent_id
    ) AS agent_id,
    pwp.withdrawal_id,
    pwp.ts,
    pwp.principal,
    COALESCE(c.commission, 0)::numeric AS commission,
    COALESCE(t.telecom_charge, 0)::numeric AS telecom_charge,
    wr.user_id AS customer_id,
    wr.payout_method,
    wr.reason AS wr_reason,
    wr.landlord_payout_id,
    wr.proxy_partner_id
  FROM posted_wallet_payouts pwp
  LEFT JOIN public.withdrawal_requests wr ON wr.id = pwp.withdrawal_id
  LEFT JOIN comm c ON c.withdrawal_id = pwp.withdrawal_id
  LEFT JOIN telecom t ON t.withdrawal_id = pwp.withdrawal_id
  LEFT JOIN LATERAL (
    SELECT gl.user_id AS agent_id
    FROM public.general_ledger gl
    CROSS JOIN day_bounds b
    WHERE gl.source_id = pwp.withdrawal_id
      AND gl.reference_id LIKE '%-cashout-commission'
      AND gl.ledger_scope = 'wallet'
      AND gl.direction = 'cash_in'
      AND gl.category = 'agent_commission_earned'
      AND gl.transaction_date >= b.start_at
      AND gl.transaction_date < b.end_at
      AND gl.user_id IS NOT NULL
    ORDER BY gl.transaction_date ASC
    LIMIT 1
  ) merchant_comm_agent ON true
  LEFT JOIN LATERAL (
    SELECT gl.user_id AS agent_id
    FROM public.general_ledger gl
    CROSS JOIN day_bounds b
    WHERE gl.source_id = pwp.withdrawal_id
      AND (gl.reference_id LIKE '%-merchant-float-consume'
        OR gl.reference_id LIKE '%-merchant-reimbursement'
        OR gl.reference_id LIKE '%-merchant-telecom-charge')
      AND gl.ledger_scope = 'wallet'
      AND gl.direction = 'cash_out'
      AND gl.transaction_date >= b.start_at
      AND gl.transaction_date < b.end_at
      AND gl.user_id IS NOT NULL
    ORDER BY gl.transaction_date ASC
    LIMIT 1
  ) merchant_float_agent ON true
),
enriched AS (
  SELECT
    po.*,
    (po.principal + po.telecom_charge) AS float_consumed,
    COALESCE(mp.full_name, 'Unknown agent') AS merchant_name,
    mp.phone AS merchant_phone,
    cp.full_name AS customer_name,
    CASE
      WHEN po.proxy_partner_id IS NOT NULL
        OR po.wr_reason ILIKE '%Portfolio:%'
        OR LOWER(COALESCE(po.wr_reason,'')) ~ '(proxy|roi|return)'
        THEN 'proxy_partner_withdrawal'
      WHEN po.landlord_payout_id IS NOT NULL
        OR LOWER(COALESCE(po.wr_reason,'')) LIKE 'landlord float payout%'
        THEN 'landlord_payouts'
      WHEN LOWER(COALESCE(po.wr_reason,'')) ~ '(salary|payroll)'
        THEN 'payroll_payments'
      WHEN LOWER(COALESCE(po.wr_reason,'')) LIKE '%commission%'
        THEN 'agent_commissions'
      ELSE 'wallet_withdrawals'
    END AS category_id
  FROM payouts po
  LEFT JOIN public.profiles mp ON mp.id = po.agent_id
  LEFT JOIN public.profiles cp ON cp.id = po.customer_id
),
summary AS (
  SELECT
    agent_id,
    COALESCE(MAX(merchant_name), 'Unknown agent') AS merchant_name,
    MAX(merchant_phone) AS merchant_phone,
    COUNT(*) AS payouts,
    SUM(principal) AS total_paid,
    SUM(commission) AS total_commission,
    SUM(telecom_charge) AS total_telecom,
    SUM(principal + telecom_charge) AS total_float_consumed
  FROM enriched
  GROUP BY agent_id
),
by_cat AS (
  SELECT
    category_id,
    COUNT(DISTINCT agent_id) AS merchant_count,
    COUNT(*) AS payouts,
    SUM(principal) AS total_paid,
    SUM(commission) AS total_commission,
    SUM(telecom_charge) AS total_telecom,
    SUM(principal + telecom_charge) AS total_float_consumed
  FROM enriched
  GROUP BY category_id
),
cat_labeled AS (
  SELECT
    category_id,
    CASE category_id
      WHEN 'proxy_partner_withdrawal' THEN 'Partner Withdrawal (Proxy Initiated)'
      WHEN 'landlord_payouts' THEN 'Landlord Payouts'
      WHEN 'payroll_payments' THEN 'Payroll Payments'
      WHEN 'agent_commissions' THEN 'Agent Commissions'
      WHEN 'wallet_withdrawals' THEN 'Wallet Withdrawals'
      ELSE category_id
    END AS category_label,
    merchant_count,
    payouts,
    total_paid,
    total_commission,
    total_telecom,
    total_float_consumed
  FROM by_cat
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
  'by_category', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'category_id', category_id,
      'category_label', category_label,
      'merchant_count', merchant_count,
      'payouts', payouts,
      'total_paid', total_paid,
      'total_commission', total_commission,
      'total_telecom', total_telecom,
      'total_float_consumed', total_float_consumed
    ) ORDER BY total_paid DESC)
    FROM cat_labeled
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
      'category_id', category_id,
      'withdrawal_id', withdrawal_id
    ) ORDER BY ts ASC, withdrawal_id ASC)
    FROM enriched
  ), '[]'::jsonb)
)
$function$;

GRANT EXECUTE ON FUNCTION public.generate_merchant_cashout_daily_report(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.generate_merchant_cashout_daily_report(date) TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('merchant-cashout-daily-report');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;

    PERFORM cron.schedule(
      'merchant-cashout-daily-report',
      '0 21 * * *',
      $cron$
      SELECT net.http_post(
        url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/merchant-cashout-daily-report',
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := '{"force":false}'::jsonb
      );
      $cron$
    );
  END IF;
END;
$$;