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
-- Customer wallet debit legs posted inside the day
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
-- Payout requests that BELONG to the day regardless of whether ledger legs exist
day_requests AS (
  SELECT wr.id AS withdrawal_id
  FROM public.withdrawal_requests wr
  CROSS JOIN day_bounds b
  WHERE wr.status IN ('paid','completed','disbursed','processing','failed','held','re_approved_for_recovery')
    AND COALESCE(wr.processed_at, wr.settlement_checked_at, wr.dispatch_claimed_at, wr.fin_ops_approved_at, wr.created_at) >= b.start_at
    AND COALESCE(wr.processed_at, wr.settlement_checked_at, wr.dispatch_claimed_at, wr.fin_ops_approved_at, wr.created_at) < b.end_at
),
candidates AS (
  SELECT withdrawal_id FROM posted_wallet_payouts
  UNION
  SELECT withdrawal_id FROM day_requests
),
comm AS (
  SELECT gl.source_id AS withdrawal_id, SUM(gl.amount)::numeric AS commission
  FROM public.general_ledger gl
  WHERE gl.source_id IN (SELECT withdrawal_id FROM candidates)
    AND gl.reference_id LIKE '%-cashout-commission'
    AND gl.ledger_scope = 'wallet'
    AND gl.direction = 'cash_in'
    AND gl.category = 'agent_commission_earned'
  GROUP BY gl.source_id
),
telecom AS (
  SELECT gl.source_id AS withdrawal_id, SUM(gl.amount)::numeric AS telecom_charge
  FROM public.general_ledger gl
  WHERE gl.source_id IN (SELECT withdrawal_id FROM candidates)
    AND gl.reference_id LIKE '%-merchant-telecom-charge'
    AND gl.ledger_scope = 'wallet'
    AND gl.direction = 'cash_out'
  GROUP BY gl.source_id
),
merchant_legs AS (
  SELECT gl.source_id AS withdrawal_id, SUM(gl.amount)::numeric AS merchant_principal
  FROM public.general_ledger gl
  WHERE gl.source_id IN (SELECT withdrawal_id FROM candidates)
    AND (gl.reference_id LIKE '%-merchant-float-consume'
      OR gl.reference_id LIKE '%-merchant-reimbursement')
    AND gl.ledger_scope = 'wallet'
    AND gl.direction = 'cash_out'
  GROUP BY gl.source_id
),
-- Customer wallet debit ANY time (not only inside the day) -> settlement truth
customer_debit_any AS (
  SELECT gl.source_id AS withdrawal_id, SUM(gl.amount)::numeric AS principal, MIN(gl.transaction_date) AS ts
  FROM public.general_ledger gl
  WHERE gl.source_id IN (SELECT withdrawal_id FROM candidates)
    AND gl.source_table = 'withdrawal_requests'
    AND gl.ledger_scope = 'wallet'
    AND gl.direction = 'cash_out'
    AND gl.category = 'wallet_withdrawal'
  GROUP BY gl.source_id
),
replayed AS (
  SELECT DISTINCT withdrawal_id
  FROM public.withdrawal_settlement_replay_audit
  WHERE dry_run IS NOT TRUE AND ok IS TRUE
),
payouts AS (
  SELECT
    COALESCE(
      ca.agent_id,
      wr.assigned_cashout_agent_id,
      wr.dispatch_claimed_by,
      wr.fin_ops_approved_by,
      wr.processed_by,
      merchant_comm_agent.agent_id,
      merchant_float_agent.agent_id
    ) AS agent_id,
    k.withdrawal_id,
    COALESCE(pwp.ts, cda.ts, wr.processed_at, wr.created_at) AS ts,
    COALESCE(pwp.principal, cda.principal, ml.merchant_principal, wr.amount, 0)::numeric AS principal,
    COALESCE(c.commission, 0)::numeric AS commission,
    COALESCE(t.telecom_charge, 0)::numeric AS telecom_charge,
    wr.user_id AS customer_id,
    wr.payout_method,
    wr.reason AS wr_reason,
    wr.landlord_payout_id,
    wr.proxy_partner_id,
    wr.status AS wr_status,
    COALESCE(wr.settlement_state, 'pending') AS settlement_state,
    COALESCE(wr.settlement_missing_legs, '[]'::jsonb) AS missing_legs,
    (cda.withdrawal_id IS NOT NULL) AS has_customer_debit,
    (wr.id IS NULL) AS orphan_ledger,
    (r.withdrawal_id IS NOT NULL) AS was_replayed
  FROM candidates k
  LEFT JOIN posted_wallet_payouts pwp ON pwp.withdrawal_id = k.withdrawal_id
  LEFT JOIN public.withdrawal_requests wr ON wr.id = k.withdrawal_id
  LEFT JOIN public.cashout_agents ca ON ca.id = wr.assigned_cashout_agent_id
  LEFT JOIN comm c ON c.withdrawal_id = k.withdrawal_id
  LEFT JOIN telecom t ON t.withdrawal_id = k.withdrawal_id
  LEFT JOIN merchant_legs ml ON ml.withdrawal_id = k.withdrawal_id
  LEFT JOIN customer_debit_any cda ON cda.withdrawal_id = k.withdrawal_id
  LEFT JOIN replayed r ON r.withdrawal_id = k.withdrawal_id
  LEFT JOIN LATERAL (
    SELECT gl.user_id AS agent_id
    FROM public.general_ledger gl
    WHERE gl.source_id = k.withdrawal_id
      AND gl.reference_id LIKE '%-cashout-commission'
      AND gl.ledger_scope = 'wallet'
      AND gl.direction = 'cash_in'
      AND gl.category = 'agent_commission_earned'
      AND gl.user_id IS NOT NULL
    ORDER BY gl.transaction_date ASC
    LIMIT 1
  ) merchant_comm_agent ON true
  LEFT JOIN LATERAL (
    SELECT gl.user_id AS agent_id
    FROM public.general_ledger gl
    WHERE gl.source_id = k.withdrawal_id
      AND (gl.reference_id LIKE '%-merchant-float-consume'
        OR gl.reference_id LIKE '%-merchant-reimbursement'
        OR gl.reference_id LIKE '%-merchant-telecom-charge')
      AND gl.ledger_scope = 'wallet'
      AND gl.direction = 'cash_out'
      AND gl.user_id IS NOT NULL
    ORDER BY gl.transaction_date ASC
    LIMIT 1
  ) merchant_float_agent ON true
),
classified AS (
  SELECT
    po.*,
    CASE
      WHEN po.orphan_ledger THEN 'exception'
      WHEN po.wr_status IN ('failed','held')
        OR (po.wr_status = 'processing' AND po.settlement_state = 'unsettled')
        THEN 'failed'
      WHEN po.settlement_state = 'settled' AND po.was_replayed THEN 'reconciled'
      WHEN po.settlement_state = 'settled'
        AND jsonb_array_length(po.missing_legs) = 0
        AND po.has_customer_debit
        THEN 'fully_settled'
      WHEN po.wr_status IN ('paid','completed','disbursed') AND NOT po.has_customer_debit
        THEN 'unsettled'
      WHEN po.settlement_state = 'unsettled'
        AND jsonb_array_length(po.missing_legs) >= 3
        THEN 'unsettled'
      WHEN po.has_customer_debit
        AND (po.settlement_state <> 'settled' OR jsonb_array_length(po.missing_legs) > 0)
        THEN 'partially_settled'
      WHEN po.wr_status = 'processing' THEN 'failed'
      ELSE 'exception'
    END AS settlement_status
  FROM payouts po
),
enriched AS (
  SELECT
    cl.*,
    (cl.principal + cl.telecom_charge) AS float_consumed,
    (cl.settlement_status IN ('fully_settled','reconciled')) AS is_clean,
    COALESCE(mp.full_name, mp2.full_name, ca2.label, 'Unknown agent') AS merchant_name,
    COALESCE(mp.phone, mp2.phone) AS merchant_phone,
    cp.full_name AS customer_name,
    CASE
      WHEN cl.proxy_partner_id IS NOT NULL
        OR cl.wr_reason ILIKE '%Portfolio:%'
        OR LOWER(COALESCE(cl.wr_reason,'')) ~ '(proxy|roi|return)'
        THEN 'proxy_partner_withdrawal'
      WHEN cl.landlord_payout_id IS NOT NULL
        OR LOWER(COALESCE(cl.wr_reason,'')) LIKE 'landlord float payout%'
        THEN 'landlord_payouts'
      WHEN LOWER(COALESCE(cl.wr_reason,'')) ~ '(salary|payroll)'
        THEN 'payroll_payments'
      WHEN LOWER(COALESCE(cl.wr_reason,'')) LIKE '%commission%'
        THEN 'agent_commissions'
      ELSE 'wallet_withdrawals'
    END AS category_id
  FROM classified cl
  LEFT JOIN public.profiles mp ON mp.id = cl.agent_id
  LEFT JOIN public.cashout_agents ca2 ON ca2.id = cl.agent_id
  LEFT JOIN public.profiles mp2 ON mp2.id = ca2.agent_id
  LEFT JOIN public.profiles cp ON cp.id = cl.customer_id
),
summary AS (
  SELECT
    agent_id,
    COALESCE(MAX(merchant_name), 'Unknown agent') AS merchant_name,
    MAX(merchant_phone) AS merchant_phone,
    COUNT(*) FILTER (WHERE is_clean) AS payouts,
    SUM(principal) FILTER (WHERE is_clean) AS total_paid,
    SUM(commission) FILTER (WHERE is_clean) AS total_commission,
    SUM(telecom_charge) FILTER (WHERE is_clean) AS total_telecom,
    SUM(principal + telecom_charge) FILTER (WHERE is_clean) AS total_float_consumed,
    COUNT(*) FILTER (WHERE NOT is_clean) AS unresolved_payouts,
    SUM(principal) FILTER (WHERE NOT is_clean) AS unresolved_amount
  FROM enriched
  GROUP BY agent_id
),
by_cat AS (
  SELECT
    category_id,
    COUNT(DISTINCT agent_id) AS merchant_count,
    COUNT(*) FILTER (WHERE is_clean) AS payouts,
    SUM(principal) FILTER (WHERE is_clean) AS total_paid,
    SUM(commission) FILTER (WHERE is_clean) AS total_commission,
    SUM(telecom_charge) FILTER (WHERE is_clean) AS total_telecom,
    SUM(principal + telecom_charge) FILTER (WHERE is_clean) AS total_float_consumed,
    COUNT(*) FILTER (WHERE NOT is_clean) AS unresolved_payouts,
    SUM(principal) FILTER (WHERE NOT is_clean) AS unresolved_amount
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
    merchant_count, payouts, total_paid, total_commission, total_telecom,
    total_float_consumed, unresolved_payouts, unresolved_amount
  FROM by_cat
),
by_status AS (
  SELECT
    settlement_status,
    CASE settlement_status
      WHEN 'fully_settled' THEN 'Fully settled'
      WHEN 'partially_settled' THEN 'Partially settled'
      WHEN 'unsettled' THEN 'Unsettled'
      WHEN 'failed' THEN 'Failed'
      WHEN 'reconciled' THEN 'Reconciled'
      ELSE 'Exception'
    END AS status_label,
    COUNT(*) AS payouts,
    SUM(principal) AS total_amount,
    SUM(commission) AS total_commission,
    SUM(telecom_charge) AS total_telecom
  FROM enriched
  GROUP BY settlement_status
)
SELECT jsonb_build_object(
  'date', p_date,
  'merchant_count', (SELECT COUNT(*) FROM summary WHERE payouts > 0),
  'total_payouts', (SELECT COALESCE(SUM(payouts), 0) FROM summary),
  'total_paid', (SELECT COALESCE(SUM(total_paid), 0) FROM summary),
  'total_commission', (SELECT COALESCE(SUM(total_commission), 0) FROM summary),
  'total_telecom', (SELECT COALESCE(SUM(total_telecom), 0) FROM summary),
  'total_float_consumed', (SELECT COALESCE(SUM(total_float_consumed), 0) FROM summary),
  'total_candidates', (SELECT COUNT(*) FROM enriched),
  'unresolved_payouts', (SELECT COUNT(*) FROM enriched WHERE NOT is_clean),
  'unresolved_amount', (SELECT COALESCE(SUM(principal), 0) FROM enriched WHERE NOT is_clean),
  'settlement_totals', (
    SELECT jsonb_object_agg(settlement_status, jsonb_build_object(
      'label', status_label,
      'payouts', payouts,
      'total_amount', total_amount
    ))
    FROM by_status
  ),
  'by_settlement_status', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'settlement_status', settlement_status,
      'status_label', status_label,
      'payouts', payouts,
      'total_amount', total_amount,
      'total_commission', total_commission,
      'total_telecom', total_telecom
    ) ORDER BY payouts DESC)
    FROM by_status
  ), '[]'::jsonb),
  'summary', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'agent_id', agent_id,
      'merchant_name', merchant_name,
      'merchant_phone', merchant_phone,
      'payouts', payouts,
      'total_paid', total_paid,
      'total_commission', total_commission,
      'total_telecom', total_telecom,
      'total_float_consumed', total_float_consumed,
      'unresolved_payouts', unresolved_payouts,
      'unresolved_amount', unresolved_amount
    ) ORDER BY total_paid DESC NULLS LAST)
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
      'total_float_consumed', total_float_consumed,
      'unresolved_payouts', unresolved_payouts,
      'unresolved_amount', unresolved_amount
    ) ORDER BY total_paid DESC NULLS LAST)
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
      'withdrawal_id', withdrawal_id,
      'settlement_status', settlement_status,
      'request_status', wr_status,
      'settlement_state', settlement_state,
      'missing_legs', missing_legs,
      'has_customer_debit', has_customer_debit
    ) ORDER BY ts ASC, withdrawal_id ASC)
    FROM enriched
  ), '[]'::jsonb),
  'exceptions', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'withdrawal_id', withdrawal_id,
      'merchant_name', merchant_name,
      'customer_name', customer_name,
      'amount', principal,
      'settlement_status', settlement_status,
      'request_status', wr_status,
      'settlement_state', settlement_state,
      'missing_legs', missing_legs,
      'has_customer_debit', has_customer_debit
    ) ORDER BY principal DESC NULLS LAST)
    FROM enriched
    WHERE NOT is_clean
  ), '[]'::jsonb)
)
$function$;

GRANT EXECUTE ON FUNCTION public.generate_merchant_cashout_daily_report(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.generate_merchant_cashout_daily_report(date) TO authenticated;