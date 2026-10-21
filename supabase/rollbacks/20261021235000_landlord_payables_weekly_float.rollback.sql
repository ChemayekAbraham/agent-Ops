-- Rollback for 20261021235000_landlord_payables_weekly_float.sql
-- Restores v_payables_lines, v_payables_payment_history and payables_category_frame to exactly what 20261020210000
-- created, get_payables_predictive_forecast to production's definition, and removes the float view, the settlement view and the weekly function. Nothing else was created.
-- ORDER: roll this back BEFORE 20261020210000_budget_payables.

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF position('v_landlord_float_payables' IN pg_get_viewdef('public.v_payables_lines'::regclass)) = 0
     OR position('v_landlord_payout_settlement' IN pg_get_viewdef('public.v_payables_payment_history'::regclass)) = 0
     OR (SELECT string_agg(category_key || ':' || sort_order, ',' ORDER BY sort_order) FROM public.payables_category_frame()) IS DISTINCT FROM 'partner:1,landlord:2,agent:3,budget:4,other:5'
     OR position('Payables scope (CFO, 2026-10-21)' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.get_payables_predictive_forecast(text,integer,date)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'precondition failed: the payables views are no longer the ones 20261021235000 created; reverse it by hand';
  END IF;
END
$pre$;

CREATE OR REPLACE VIEW public.v_payables_lines AS
SELECT 'user'::text AS category_key,
    'User Wallets & Withdrawals'::text AS category_label,
    'withdrawal_request'::text AS product_key,
    'Withdrawal Requests In Flight'::text AS product_label,
    'withdrawal_requests'::text AS source_table,
    w.id AS item_id,
    w.user_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown user'::text) AS counterparty_name,
    GREATEST(COALESCE(w.amount, 0::numeric), 0::numeric) AS outstanding_amount,
    (w.created_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    w.status,
    w.created_at
   FROM withdrawal_requests w
     LEFT JOIN profiles p ON p.id = w.user_id
  WHERE (w.status = ANY (ARRAY['pending'::text, 'approved'::text, 'processing'::text, 're_approved_for_recovery'::text])) AND COALESCE(w.amount, 0::numeric) > 0::numeric
UNION ALL
 SELECT 'user'::text AS category_key,
    'User Wallets & Withdrawals'::text AS category_label,
    'wallet_balance'::text AS product_key,
    'Withdrawable Wallet Balances'::text AS product_label,
    'wallets'::text AS source_table,
    wl.id AS item_id,
    wl.user_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown user'::text) AS counterparty_name,
    GREATEST(COALESCE(wl.withdrawable_balance, 0::numeric), 0::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    0::numeric AS daily_amount,
    'available'::text AS status,
    wl.created_at
   FROM wallets wl
     LEFT JOIN profiles p ON p.id = wl.user_id
  WHERE COALESCE(wl.withdrawable_balance, 0::numeric) > 0::numeric
UNION ALL
 SELECT 'partner'::text AS category_key,
    'Supporter Returns & Capital'::text AS category_label,
    'supporter_returns'::text AS product_key,
    'Supporter Returns Due'::text AS product_label,
    'investor_portfolios'::text AS source_table,
    ip.id AS item_id,
    ip.investor_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown supporter'::text) AS counterparty_name,
    GREATEST(round(COALESCE(ip.investment_amount, 0::numeric) * COALESCE(ip.roi_percentage, 0::numeric) / 100.0, 2), 0::numeric) AS outstanding_amount,
    ip.next_roi_date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    ip.status,
    ip.created_at
   FROM investor_portfolios ip
     LEFT JOIN profiles p ON p.id = ip.investor_id
  WHERE ip.status = 'active'::text AND ip.next_roi_date IS NOT NULL AND (COALESCE(ip.investment_amount, 0::numeric) * COALESCE(ip.roi_percentage, 0::numeric)) > 0::numeric
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'Landlord Rent Payouts'::text AS category_label,
    'landlord_payout'::text AS product_key,
    'Landlord Payouts Outstanding'::text AS product_label,
    'landlord_payouts'::text AS source_table,
    lp.id AS item_id,
    lp.landlord_id AS counterparty_id,
    COALESCE(NULLIF(lp.landlord_name, ''::text), p.full_name, 'Unknown landlord'::text) AS counterparty_name,
    GREATEST(COALESCE(lp.amount, 0::numeric), 0::numeric) AS outstanding_amount,
    (lp.created_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    lp.status,
    lp.created_at
   FROM landlord_payouts lp
     LEFT JOIN profiles p ON p.id = lp.landlord_id
  WHERE (lp.status = ANY (ARRAY['awaiting_agent_receipt'::text, 'pending_merchant_payout'::text, 'failed'::text, 'pending'::text])) AND COALESCE(lp.amount, 0::numeric) > 0::numeric
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'Landlord Rent Payouts'::text AS category_label,
    'agent_landlord_payout'::text AS product_key,
    'Agent Landlord Payouts Pending'::text AS product_label,
    'agent_landlord_payouts'::text AS source_table,
    ap.id AS item_id,
    ap.landlord_id AS counterparty_id,
    COALESCE(NULLIF(ap.landlord_name, ''::text), p.full_name, 'Unknown landlord'::text) AS counterparty_name,
    GREATEST(COALESCE(ap.amount, 0::numeric), 0::numeric) AS outstanding_amount,
    (ap.created_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    ap.status,
    ap.created_at
   FROM agent_landlord_payouts ap
     LEFT JOIN profiles p ON p.id = ap.landlord_id
  WHERE (ap.status = ANY (ARRAY['pending'::text, 'landlord_ops_approved'::text, 'cfo_pending'::text])) AND COALESCE(ap.amount, 0::numeric) > 0::numeric
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Payables'::text AS category_label,
    'agent_commission_payout'::text AS product_key,
    'Agent Commission Payouts'::text AS product_label,
    'agent_commission_payouts'::text AS source_table,
    cp.id AS item_id,
    cp.agent_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown agent'::text) AS counterparty_name,
    GREATEST(COALESCE(cp.amount, 0::numeric), 0::numeric) AS outstanding_amount,
    (cp.requested_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    cp.status,
    cp.created_at
   FROM agent_commission_payouts cp
     LEFT JOIN profiles p ON p.id = cp.agent_id
  WHERE (cp.status = ANY (ARRAY['pending'::text, 'approved'::text])) AND COALESCE(cp.amount, 0::numeric) > 0::numeric
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Payables'::text AS category_label,
    'agent_float_withdrawal'::text AS product_key,
    'Agent Float Withdrawals In Flight'::text AS product_label,
    'agent_float_withdrawals'::text AS source_table,
    fw.id AS item_id,
    fw.agent_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown agent'::text) AS counterparty_name,
    GREATEST(COALESCE(fw.amount, 0::numeric), 0::numeric) AS outstanding_amount,
    (fw.created_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    fw.status,
    fw.created_at
   FROM agent_float_withdrawals fw
     LEFT JOIN profiles p ON p.id = fw.agent_id
  WHERE (fw.status = ANY (ARRAY['pending'::text, 'agent_ops_approved'::text, 'manager_approved'::text, 'processing'::text])) AND COALESCE(fw.amount, 0::numeric) > 0::numeric
UNION ALL
 SELECT 'staff'::text AS category_key,
    'Payroll & Staff'::text AS category_label,
    'payroll_disbursement'::text AS product_key,
    'Payroll Disbursements Pending'::text AS product_label,
    'hr_pay_disbursements'::text AS source_table,
    d.id AS item_id,
    d.user_id AS counterparty_id,
    COALESCE(p.full_name, 'Staff member'::text) AS counterparty_name,
    GREATEST(COALESCE(d.amount, 0::numeric), 0::numeric) AS outstanding_amount,
    (d.created_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    d.status,
    d.created_at
   FROM hr_pay_disbursements d
     LEFT JOIN profiles p ON p.id = d.user_id
  WHERE (COALESCE(d.status, ''::text) <> ALL (ARRAY['posted'::text, 'cancelled'::text, 'reversed'::text])) AND COALESCE(d.amount, 0::numeric) > 0::numeric
UNION ALL
 SELECT 'budget'::text AS category_key,
    'Departmental Budgets'::text AS category_label,
    CASE WHEN b.overspent THEN 'department_budget_overspent'::text ELSE 'department_budget'::text END AS product_key,
    CASE WHEN b.overspent THEN 'Departmental Budgets — overspent (credited above budget)'::text
         ELSE 'Departmental Weekly Budgets'::text END AS product_label,
    'budget_submission_lines'::text AS source_table,
    b.line_id AS item_id,
    b.department_id AS counterparty_id,
    COALESCE(b.department_name, 'Unknown department'::text) AS counterparty_name,
    b.outstanding_amount,
    b.period_end AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    CASE WHEN b.overspent THEN 'overspent'::text
         WHEN b.unproven_credit_amount > 0::numeric THEN 'credit_unproven'::text
         ELSE b.submission_status END AS status,
    b.line_created_at AS created_at
   FROM public.v_budget_payables_lines b
  -- B3: an overspent line stays on the report (amount 0, its own product and status) instead of vanishing.
  WHERE b.outstanding_amount > 0::numeric OR b.overspent;

CREATE OR REPLACE VIEW public.v_payables_payment_history AS
SELECT 'user'::text AS category_key,
    'withdrawal_request'::text AS product_key,
    (COALESCE(w.processed_at, w.updated_at) AT TIME ZONE 'Africa/Nairobi'::text)::date AS d,
    COALESCE(w.amount, 0::numeric) AS amount
   FROM withdrawal_requests w
  WHERE (w.status = ANY (ARRAY['completed'::text, 'paid'::text])) AND COALESCE(w.processed_at, w.updated_at) IS NOT NULL
UNION ALL
 SELECT 'partner'::text AS category_key,
    'supporter_returns'::text AS product_key,
    (g.transaction_date AT TIME ZONE 'Africa/Nairobi'::text)::date AS d,
    COALESCE(g.amount, 0::numeric) AS amount
   FROM general_ledger g
  WHERE g.direction = 'cash_out'::text AND g.ledger_scope = 'platform'::text AND g.category = 'roi_expense'::text
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'landlord_payout'::text AS product_key,
    (g.transaction_date AT TIME ZONE 'Africa/Nairobi'::text)::date AS d,
    COALESCE(g.amount, 0::numeric) AS amount
   FROM general_ledger g
  WHERE g.direction = 'cash_out'::text AND g.ledger_scope = 'platform'::text AND g.category = 'rent_disbursement'::text
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'agent_landlord_payout'::text AS product_key,
    (g.transaction_date AT TIME ZONE 'Africa/Nairobi'::text)::date AS d,
    COALESCE(g.amount, 0::numeric) AS amount
   FROM general_ledger g
  WHERE g.direction = 'cash_out'::text AND g.ledger_scope = 'platform'::text AND g.category = 'agent_landlord_payout'::text
UNION ALL
 SELECT 'agent'::text AS category_key,
    'agent_commission_payout'::text AS product_key,
    (g.transaction_date AT TIME ZONE 'Africa/Nairobi'::text)::date AS d,
    COALESCE(g.amount, 0::numeric) AS amount
   FROM general_ledger g
  WHERE g.direction = 'cash_out'::text AND g.ledger_scope = 'platform'::text AND g.category = 'agent_commission_payable'::text
UNION ALL
 SELECT 'staff'::text AS category_key,
    'payroll_disbursement'::text AS product_key,
    (g.transaction_date AT TIME ZONE 'Africa/Nairobi'::text)::date AS d,
    COALESCE(g.amount, 0::numeric) AS amount
   FROM general_ledger g
  WHERE g.direction = 'cash_out'::text AND g.ledger_scope = 'platform'::text AND g.category = 'salary_payout'::text
UNION ALL
 SELECT 'budget'::text AS category_key,
    'department_budget'::text AS product_key,
    (w.credited_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS d,
    COALESCE(w.amount, 0::numeric) AS amount
   FROM public.requisition_wallet_credits w
  WHERE w.status = 'credited'::text AND w.credited_at IS NOT NULL
    -- B1: only credits the wallet ledger proves count as paid
    AND NULLIF(w.wallet_transaction_id, ''::text) IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.general_ledger g
                 WHERE g.reference_id = w.wallet_transaction_id AND g.ledger_scope = 'wallet'::text
                   AND g.direction = 'cash_in'::text AND g.user_id = w.user_id AND abs(g.amount - w.amount) < 1::numeric)
    AND EXISTS (SELECT 1 FROM public.v_budget_payables_lines b
                 WHERE b.line_id = CASE w.source_table
                   WHEN 'staff_requisitions'    THEN (SELECT s.budget_line_id FROM public.staff_requisitions s    WHERE s.id = w.requisition_id)
                   WHEN 'employee_requisitions' THEN (SELECT e.budget_line_id FROM public.employee_requisitions e WHERE e.id = w.requisition_id)
                   WHEN 'director_requisitions' THEN (SELECT d.budget_line_id FROM public.director_requisitions d WHERE d.id = w.requisition_id)
                 END);

CREATE OR REPLACE FUNCTION public.payables_category_frame()
 RETURNS TABLE(category_key text, category_label text, sort_order integer)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT * FROM (VALUES
    ('user','User Wallets & Withdrawals',1),
    ('partner','Supporter Returns & Capital',2),
    ('landlord','Landlord Rent Payouts',3),
    ('agent','Agent Payables',4),
    ('staff','Payroll & Staff',5),
    ('budget','Departmental Budgets',6),
    ('other','Unclassified / Other',7)
  ) f(category_key, category_label, sort_order)
$function$;

CREATE OR REPLACE FUNCTION public.get_payables_predictive_forecast(p_granularity text DEFAULT 'month'::text, p_periods integer DEFAULT 12, p_as_at date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gran text := lower(COALESCE(p_granularity, 'month'));
  v_periods integer := LEAST(GREATEST(COALESCE(p_periods, 12), 1), 60);
  v_today date := COALESCE(p_as_at, (now() AT TIME ZONE 'Africa/Nairobi')::date);
  v_result jsonb;
BEGIN
  PERFORM payables_guard();
  IF v_gran NOT IN ('day','week','month','quarter','year') THEN
    v_gran := 'month';
  END IF;

WITH params AS (
  SELECT v_gran AS gran, v_periods AS periods, v_today AS today, 365 AS lookback,
         CASE v_gran WHEN 'day' THEN interval '1 day' WHEN 'week' THEN interval '1 week'
              WHEN 'month' THEN interval '1 month' WHEN 'quarter' THEN interval '3 months'
              ELSE interval '1 year' END AS step,
         CASE v_gran WHEN 'day' THEN v_today
              WHEN 'week' THEN date_trunc('week', v_today)::date
              WHEN 'month' THEN date_trunc('month', v_today)::date
              WHEN 'quarter' THEN date_trunc('quarter', v_today)::date
              ELSE date_trunc('year', v_today)::date END AS base
), hist AS (
  SELECT h.category_key ck, h.product_key pk, h.d, SUM(h.amount) amt
  FROM v_payables_payment_history h CROSS JOIN params p
  WHERE h.d IS NOT NULL AND h.d > p.today - p.lookback AND h.d <= p.today AND h.amount > 0
  GROUP BY 1,2,3
), span AS (
  SELECT ck, pk, MIN(d) first_d, COUNT(*) sample_days FROM hist GROUP BY 1,2
), dense AS (
  SELECT s.ck, s.pk, g::date d, COALESCE(h.amt,0) amt
  FROM span s CROSS JOIN params p
  CROSS JOIN LATERAL generate_series(s.first_d, p.today, interval '1 day') g
  LEFT JOIN hist h ON h.ck = s.ck AND h.pk = s.pk AND h.d = g::date
), lvl AS (
  SELECT d.ck, d.pk,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY d.amt) FILTER (WHERE d.d > p.today - 28) AS level_recent,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY d.amt) FILTER (WHERE d.d > p.today - 42 AND d.d <= p.today - 14) AS level_prior,
    SUM(d.amt) FILTER (WHERE d.d > p.today - 14) AS holdout_actual
  FROM dense d CROSS JOIN params p GROUP BY 1,2
), slope AS (
  SELECT ck, pk, regr_slope(wk_amt, wk_idx) / 7.0 AS slope_per_day
  FROM (SELECT d.ck, d.pk, (d.d - p.today)/7 AS wk_idx, SUM(d.amt) wk_amt
        FROM dense d CROSS JOIN params p GROUP BY 1,2,3) w
  GROUP BY 1,2
), dowf AS (
  SELECT w.ck, w.pk, w.dw,
    CASE WHEN l.level_recent > 0 THEN LEAST(2.5, GREATEST(0.1, w.med_dow / l.level_recent)) ELSE 1 END AS f
  FROM (SELECT d.ck, d.pk, EXTRACT(dow FROM d.d)::int dw,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY d.amt) AS med_dow
        FROM dense d CROSS JOIN params p WHERE d.d > p.today - 84 GROUP BY 1,2,3) w
  JOIN lvl l ON l.ck=w.ck AND l.pk=w.pk
), model AS (
  SELECT s.ck, s.pk, s.sample_days, (p.today - s.first_d + 1) AS lookback_days,
    COALESCE(l.level_recent,0) AS level,
    COALESCE(sl.slope_per_day,0) AS slope_per_day,
    CASE WHEN COALESCE(l.holdout_actual,0) > 0
      THEN LEAST(1.5, ABS(COALESCE(l.level_prior,0)*14 - l.holdout_actual) / l.holdout_actual)
      ELSE NULL END AS mape,
    CASE WHEN s.sample_days < 8 OR COALESCE(l.level_recent,0) <= 0 THEN 'insufficient_data'
         WHEN s.sample_days < 21 THEN 'robust_level'
         WHEN s.sample_days < 60 THEN 'level_plus_trend'
         ELSE 'seasonal_level_trend' END AS method
  FROM span s CROSS JOIN params p
  LEFT JOIN lvl l ON l.ck=s.ck AND l.pk=s.pk
  LEFT JOIN slope sl ON sl.ck=s.ck AND sl.pk=s.pk
), labels AS (
  SELECT DISTINCT category_key ck, category_label cl, product_key pk, product_label pl FROM v_payables_lines
), outs AS (
  SELECT category_key ck, product_key pk, ROUND(SUM(outstanding_amount),2) outstanding
  FROM v_payables_lines GROUP BY 1,2
), orig_raw AS (
  -- New obligations created, per day, from the obligation tables themselves
  SELECT 'user'::text ck, 'withdrawal_request'::text pk,
         (w.created_at AT TIME ZONE 'Africa/Nairobi')::date d, COALESCE(w.amount,0)::numeric amt
  FROM withdrawal_requests w
  WHERE w.status NOT IN ('rejected','cancelled','expired','failed')
  UNION ALL
  SELECT 'landlord','landlord_payout',(lp.created_at AT TIME ZONE 'Africa/Nairobi')::date, COALESCE(lp.amount,0)
  FROM landlord_payouts lp
  UNION ALL
  SELECT 'landlord','agent_landlord_payout',(ap.created_at AT TIME ZONE 'Africa/Nairobi')::date, COALESCE(ap.amount,0)
  FROM agent_landlord_payouts ap
  UNION ALL
  SELECT 'agent','agent_commission_payout',(cp.created_at AT TIME ZONE 'Africa/Nairobi')::date, COALESCE(cp.amount,0)
  FROM agent_commission_payouts cp
  WHERE cp.status <> 'rejected'
  UNION ALL
  SELECT 'staff','payroll_disbursement',(d.created_at AT TIME ZONE 'Africa/Nairobi')::date, COALESCE(d.amount,0)
  FROM hr_pay_disbursements d
  UNION ALL
  SELECT 'partner','supporter_returns',(g.transaction_date AT TIME ZONE 'Africa/Nairobi')::date, COALESCE(g.amount,0)
  FROM general_ledger g
  WHERE g.category = 'roi_accrued'
), orig_hist AS (
  SELECT o.ck, o.pk, o.d, SUM(o.amt) amt
  FROM orig_raw o CROSS JOIN params p
  WHERE o.d IS NOT NULL AND o.d > p.today - p.lookback AND o.d <= p.today AND o.amt > 0
  GROUP BY 1,2,3
), orig_span AS (
  SELECT ck, pk, MIN(d) first_d, COUNT(*) sample_days FROM orig_hist GROUP BY 1,2
), orig_dense AS (
  SELECT s.ck, s.pk, g::date d, COALESCE(h.amt,0) amt
  FROM orig_span s CROSS JOIN params p
  CROSS JOIN LATERAL generate_series(s.first_d, p.today, interval '1 day') g
  LEFT JOIN orig_hist h ON h.ck = s.ck AND h.pk = s.pk AND h.d = g::date
), orig_lvl AS (
  SELECT d.ck, d.pk,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY d.amt) FILTER (WHERE d.d > p.today - 28) AS level_recent,
    AVG(d.amt) FILTER (WHERE d.d > p.today - 28) AS mean_recent
  FROM orig_dense d CROSS JOIN params p GROUP BY 1,2
), orig_slope AS (
  SELECT ck, pk, regr_slope(wk_amt, wk_idx) / 7.0 AS slope_per_day
  FROM (SELECT d.ck, d.pk, (d.d - p.today)/7 AS wk_idx, SUM(d.amt) wk_amt
        FROM orig_dense d CROSS JOIN params p GROUP BY 1,2,3) w
  GROUP BY 1,2
), orig_totals AS (
  SELECT ck, pk, SUM(amt) AS originated_lookback FROM orig_hist GROUP BY 1,2
), paid_totals AS (
  SELECT ck, pk, SUM(amt) AS paid_lookback FROM hist GROUP BY 1,2
), orig_model AS (
  SELECT s.ck, s.pk, s.sample_days,
    GREATEST(COALESCE(l.level_recent,0), COALESCE(l.mean_recent,0) * 0.5) AS level,
    COALESCE(sl.slope_per_day,0) AS slope_per_day,
    LEAST(1.0, GREATEST(0.05,
      COALESCE(pt.paid_lookback,0) / NULLIF(ot.originated_lookback,0)
    )) AS payment_rate,
    LEAST(730, GREATEST(7,
      COALESCE(o.outstanding,0) / NULLIF(GREATEST(m.level, 1), 0)
    )) AS term_days,
    CASE WHEN s.sample_days < 8 THEN 'insufficient_data'
         WHEN s.sample_days < 21 THEN 'robust_level'
         ELSE 'level_plus_trend' END AS method
  FROM orig_span s
  LEFT JOIN orig_lvl l ON l.ck=s.ck AND l.pk=s.pk
  LEFT JOIN orig_slope sl ON sl.ck=s.ck AND sl.pk=s.pk
  LEFT JOIN orig_totals ot ON ot.ck=s.ck AND ot.pk=s.pk
  LEFT JOIN paid_totals pt ON pt.ck=s.ck AND pt.pk=s.pk
  LEFT JOIN outs o ON o.ck=s.ck AND o.pk=s.pk
  LEFT JOIN model m ON m.ck=s.ck AND m.pk=s.pk
), periods AS (
  SELECT i,
    (p.base + (p.step * i))::date AS period_start,
    ((p.base + (p.step * (i+1))) - interval '1 day')::date AS period_end
  FROM params p CROSS JOIN generate_series(0, p.periods - 1) i
), horizon AS (
  SELECT MIN(GREATEST(period_start, (SELECT today FROM params))) f, MAX(period_end) t FROM periods
), day_fc AS (
  SELECT m.ck, m.pk, g::date d,
    GREATEST(0::numeric,
      (m.level + m.slope_per_day
        * LEAST(1, GREATEST(0.15, 1 - COALESCE(m.mape, 0.7)))
        * (1.0 / (1 + ((g::date - p.today)::numeric / 365.0)))
        * (g::date - p.today))
      * CASE WHEN m.method = 'seasonal_level_trend' THEN COALESCE(f.f, 1) ELSE 1 END
    ) AS amt
  FROM model m
  CROSS JOIN params p
  CROSS JOIN horizon h
  CROSS JOIN LATERAL generate_series(h.f, h.t, interval '1 day') g
  LEFT JOIN dowf f ON f.ck = m.ck AND f.pk = m.pk AND f.dw = EXTRACT(dow FROM g)::int
  WHERE m.method <> 'insufficient_data'
), day_orig AS (
  SELECT om.ck, om.pk, g::date d,
    GREATEST(0::numeric,
      LEAST(
        om.level * 3.0,
        om.level + om.slope_per_day
          * (1.0 / (1 + ((g::date - p.today)::numeric / 365.0)))
          * (g::date - p.today)
      )
      * om.payment_rate
      * LEAST(1.0, ((g::date - p.today)::numeric + 1) / om.term_days)
    ) AS amt
  FROM orig_model om
  CROSS JOIN params p
  CROSS JOIN horizon h
  CROSS JOIN LATERAL generate_series(h.f, h.t, interval '1 day') g
  WHERE om.method <> 'insufficient_data'
), fc_period AS (
  SELECT pr.i, df.ck, df.pk, ROUND(SUM(df.amt)::numeric,2) amt
  FROM day_fc df JOIN periods pr ON df.d BETWEEN pr.period_start AND pr.period_end
  GROUP BY 1,2,3
), orig_period AS (
  SELECT pr.i, df.ck, df.pk, ROUND(SUM(df.amt)::numeric,2) amt
  FROM day_orig df JOIN periods pr ON df.d BETWEEN pr.period_start AND pr.period_end
  GROUP BY 1,2,3
), fc_split AS (
  SELECT f.*, o.outstanding,
    SUM(f.amt) OVER (PARTITION BY f.ck, f.pk ORDER BY f.i) AS cum
  FROM fc_period f LEFT JOIN outs o ON o.ck=f.ck AND o.pk=f.pk
), fc_final AS (
  SELECT i, ck, pk,
    ROUND(LEAST(cum, COALESCE(outstanding,0)) - LEAST(cum - amt, COALESCE(outstanding,0)), 2) AS runoff
  FROM fc_split
), modelled AS (
  SELECT COALESCE(r.i, o.i) i, COALESCE(r.ck, o.ck) ck, COALESCE(r.pk, o.pk) pk,
    COALESCE(r.runoff,0) AS runoff, COALESCE(o.amt,0) AS new_orig
  FROM fc_final r
  FULL OUTER JOIN orig_period o ON o.i=r.i AND o.ck=r.ck AND o.pk=r.pk
), sched AS (
  SELECT pr.i, l.category_key ck, l.product_key pk, ROUND(SUM(l.outstanding_amount),2) amt
  FROM v_payables_lines l
  JOIN periods pr ON l.due_date BETWEEN GREATEST(pr.period_start, (SELECT today FROM params)) AND pr.period_end
  WHERE l.due_date IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM model m WHERE m.ck=l.category_key AND m.pk=l.product_key AND m.method <> 'insufficient_data')
  GROUP BY 1,2,3
), combined AS (
  SELECT i, ck, pk, (runoff + new_orig) AS total, runoff, new_orig, 'modelled'::text basis FROM modelled
  UNION ALL
  SELECT i, ck, pk, amt, amt, 0, 'scheduled'::text FROM sched
), hist_span AS (
  SELECT GREATEST(1, (SELECT today FROM params) - MIN(d)) AS span_days FROM hist
), per_period AS (
  SELECT c.i, ROUND(SUM(c.total),2) total, ROUND(SUM(c.runoff),2) runoff, ROUND(SUM(c.new_orig),2) new_orig,
    ROUND(COALESCE(SUM(c.total * COALESCE(m.mape, 0.5)::numeric) FILTER (WHERE c.basis='modelled')
      / NULLIF(SUM(c.total) FILTER (WHERE c.basis='modelled'), 0), 0.5)::numeric, 4) AS wmape,
    ROUND(COALESCE(SUM(c.total) FILTER (WHERE c.basis='scheduled'),0),2) AS scheduled_total,
    jsonb_agg(jsonb_build_object(
      'category_key', c.ck, 'category_label', COALESCE(lb.cl, c.ck),
      'product_key', c.pk, 'product_label', COALESCE(lb.pl, c.pk),
      'amount', ROUND(c.total,2), 'runoff', ROUND(c.runoff,2),
      'new_origination', ROUND(c.new_orig,2), 'basis', c.basis
    ) ORDER BY c.total DESC) AS sources
  FROM combined c
  LEFT JOIN model m ON m.ck=c.ck AND m.pk=c.pk
  LEFT JOIN labels lb ON lb.ck=c.ck AND lb.pk=c.pk
  GROUP BY c.i
), period_quality AS (
  SELECT pr.i, pr.period_start, pr.period_end, pp.total, pp.runoff, pp.new_orig, pp.wmape,
    pp.scheduled_total, pp.sources, p.today, p.gran, hs.span_days,
    GREATEST(0, pr.period_end - p.today) AS horizon_days,
    CASE
      WHEN pp.total IS NULL THEN 'insufficient'
      WHEN GREATEST(0, pr.period_end - p.today) > COALESCE(hs.span_days,1) * 2
        OR (p.gran = 'year' AND pr.period_start > date_trunc('year', p.today)::date) THEN 'low'
      WHEN GREATEST(0, pr.period_end - p.today) > COALESCE(hs.span_days,1) THEN
        CASE WHEN COALESCE(pp.wmape,1) < 0.4 THEN 'medium' ELSE 'low' END
      WHEN COALESCE(pp.wmape,1) < 0.2 THEN 'high'
      WHEN COALESCE(pp.wmape,1) < 0.4 THEN 'medium'
      ELSE 'low' END AS quality,
    CASE
      WHEN pp.total IS NULL THEN 'no modelled stream has enough history for this period'
      WHEN GREATEST(0, pr.period_end - p.today) > COALESCE(hs.span_days,1) * 2
        OR (p.gran = 'year' AND pr.period_start > date_trunc('year', p.today)::date)
        THEN 'extrapolation far beyond the ' || COALESCE(hs.span_days,0) || ' days of observed payment history - treat as directional only'
      WHEN GREATEST(0, pr.period_end - p.today) > COALESCE(hs.span_days,1)
        THEN 'horizon exceeds the ' || COALESCE(hs.span_days,0) || ' days of observed payment history'
      ELSE 'within observed history span; backtest error ' || ROUND(COALESCE(pp.wmape,0.5)*100,1) || '%' END AS quality_reason
  FROM periods pr CROSS JOIN params p LEFT JOIN hist_span hs ON true
  LEFT JOIN per_period pp ON pp.i = pr.i
), periods_json AS (
  SELECT jsonb_agg(jsonb_build_object(
    'index', q.i,
    'period_start', q.period_start, 'period_end', q.period_end,
    'forecast_from', GREATEST(q.period_start, q.today),
    'is_partial_period', q.period_start < q.today,
    'label', CASE q.gran
        WHEN 'day' THEN to_char(q.period_start,'DD Mon')
        WHEN 'week' THEN 'Wk ' || to_char(q.period_start,'IW YYYY')
        WHEN 'month' THEN to_char(q.period_start,'Mon YYYY')
        WHEN 'quarter' THEN 'Q' || to_char(q.period_start,'Q YYYY')
        ELSE to_char(q.period_start,'YYYY') END,
    'forecast_amount', COALESCE(q.total,0),
    'runoff_amount', COALESCE(q.runoff,0),
    'new_origination_amount', COALESCE(q.new_orig,0),
    'scheduled_amount', COALESCE(q.scheduled_total,0),
    'low', ROUND(COALESCE(q.total,0) * (1 - LEAST(0.6, GREATEST(0.1, COALESCE(q.wmape,0.5)))),2),
    'high', ROUND(COALESCE(q.total,0) * (1 + LEAST(0.6, GREATEST(0.1, COALESCE(q.wmape,0.5)))),2),
    'confidence', LEAST(
        CASE q.quality WHEN 'low' THEN 0.35 WHEN 'medium' THEN 0.6 WHEN 'insufficient' THEN 0.05 ELSE 0.95 END,
        ROUND(GREATEST(0.05, LEAST(0.95, (1 - COALESCE(q.wmape,0.5))
          * (1.0 / (1 + q.horizon_days::numeric / 365.0)))),3)),
    'quality', q.quality,
    'quality_reason', q.quality_reason,
    'is_forecast', true,
    'sources', COALESCE(q.sources, '[]'::jsonb)
  ) ORDER BY q.i) j
  FROM period_quality q
), hist_json AS (
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'period_start')), '[]'::jsonb) j FROM (
    SELECT jsonb_build_object(
      'period_start', bucket, 'label', CASE p.gran
        WHEN 'day' THEN to_char(bucket,'DD Mon') WHEN 'week' THEN 'Wk ' || to_char(bucket,'IW YYYY')
        WHEN 'month' THEN to_char(bucket,'Mon YYYY') WHEN 'quarter' THEN 'Q' || to_char(bucket,'Q YYYY')
        ELSE to_char(bucket,'YYYY') END,
      'actual_amount', ROUND(SUM(amt),2), 'is_forecast', false) x
    FROM (
      SELECT CASE p.gran WHEN 'day' THEN h.d WHEN 'week' THEN date_trunc('week',h.d)::date
                  WHEN 'month' THEN date_trunc('month',h.d)::date
                  WHEN 'quarter' THEN date_trunc('quarter',h.d)::date
                  ELSE date_trunc('year',h.d)::date END AS bucket, h.amt
      FROM hist h CROSS JOIN params p
    ) b CROSS JOIN params p
    GROUP BY bucket, p.gran
    ORDER BY bucket DESC
    LIMIT (SELECT periods FROM params)
  ) s
), actual_json AS (
  SELECT jsonb_build_object(
    'total', ROUND(COALESCE(SUM(outstanding_amount),0),2),
    'item_count', COUNT(*),
    'overdue', ROUND(COALESCE(SUM(outstanding_amount) FILTER (WHERE due_date IS NOT NULL AND due_date < (SELECT today FROM params)),0),2),
    'not_yet_due', ROUND(COALESCE(SUM(outstanding_amount) FILTER (WHERE due_date IS NULL OR due_date >= (SELECT today FROM params)),0),2),
    'categories', COALESCE((SELECT jsonb_agg(jsonb_build_object('category_key',ck,'category_label',cl,'outstanding',amt) ORDER BY amt DESC)
       FROM (SELECT category_key ck, MAX(category_label) cl, ROUND(SUM(outstanding_amount),2) amt
             FROM v_payables_lines GROUP BY 1) c), '[]'::jsonb)
  ) j FROM v_payables_lines
), streams_json AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'category_key', m.ck, 'category_label', COALESCE(lb.cl, m.ck),
    'product_key', m.pk, 'product_label', COALESCE(lb.pl, m.pk),
    'method', m.method, 'sample_days', m.sample_days, 'lookback_days', m.lookback_days,
    'median_daily', ROUND(m.level::numeric,2), 'trend_per_week', ROUND((m.slope_per_day * 7)::numeric, 2),
    'backtest_mape', m.mape, 'seasonality_applied', m.method = 'seasonal_level_trend',
    'insufficient_data', m.method = 'insufficient_data',
    'outstanding', COALESCE(o.outstanding, 0),
    'origination', CASE WHEN om.ck IS NULL THEN NULL ELSE jsonb_build_object(
        'method', om.method,
        'sample_days', om.sample_days,
        'daily_new_payables', ROUND(om.level::numeric,2),
        'trend_per_week', ROUND((om.slope_per_day * 7)::numeric,2),
        'payment_rate', ROUND(om.payment_rate::numeric,4),
        'term_days', ROUND(om.term_days::numeric,0)
      ) END
  ) ORDER BY m.level DESC), '[]'::jsonb) j
  FROM model m LEFT JOIN labels lb ON lb.ck=m.ck AND lb.pk=m.pk
  LEFT JOIN outs o ON o.ck=m.ck AND o.pk=m.pk
  LEFT JOIN orig_model om ON om.ck=m.ck AND om.pk=m.pk AND om.method <> 'insufficient_data'
), no_hist AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'category_key', o.ck, 'product_key', o.pk,
    'product_label', COALESCE(lb.pl, o.pk), 'outstanding', o.outstanding,
    'reason', 'no payment history - contractual due dates only') ORDER BY o.outstanding DESC), '[]'::jsonb) j
  FROM outs o LEFT JOIN labels lb ON lb.ck=o.ck AND lb.pk=o.pk
  WHERE NOT EXISTS (SELECT 1 FROM model m WHERE m.ck=o.ck AND m.pk=o.pk AND m.method <> 'insufficient_data')
), no_orig AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'category_key', o.ck, 'product_key', o.pk,
    'product_label', COALESCE(lb.pl, o.pk), 'outstanding', o.outstanding,
    'reason', 'no obligation-creation history - existing book run-off only, no new obligations forecast'
  ) ORDER BY o.outstanding DESC), '[]'::jsonb) j
  FROM outs o LEFT JOIN labels lb ON lb.ck=o.ck AND lb.pk=o.pk
  WHERE NOT EXISTS (SELECT 1 FROM orig_model om WHERE om.ck=o.ck AND om.pk=o.pk AND om.method <> 'insufficient_data')
)
SELECT jsonb_build_object(
  'currency','UGX',
  'granularity', (SELECT gran FROM params),
  'periods_requested', (SELECT periods FROM params),
  'as_at', (SELECT today FROM params),
  'timezone','Africa/Nairobi',
  'actual', (SELECT j FROM actual_json),
  'history', (SELECT j FROM hist_json),
  'periods', COALESCE((SELECT j FROM periods_json), '[]'::jsonb),
  'streams', (SELECT j FROM streams_json),
  'scheduled_only_streams', (SELECT j FROM no_hist),
  'origination_only_streams', (SELECT j FROM no_orig),
  'meta', jsonb_build_object(
    'history_span_days', (SELECT span_days FROM hist_span),
    'lookback_days', (SELECT lookback FROM params),
    'model_version', 'payables runoff+obligations v1 (2026-08-26)',
    'method_note', 'Two components, both modelled from live history with no hardcoded growth rates. (1) Run-off of the recorded payables book: per-stream robust level (28-day median of actual payments) with weekly OLS trend, damped by holdout error and horizon distance, day-of-week seasonality when >=60 observed days, cumulatively capped at what is actually outstanding. (2) New obligations: per-stream daily new-payable level and weekly trend from the obligation tables, multiplied by the stream''s observed payment rate (paid divided by created over the same lookback) and ramped over its implied settlement term, bounded at 3x the observed level so long horizons cannot run away. Streams with contractual due dates but no payment history are carried at their scheduled amounts. Forecast quality is capped relative to the observed history span, so horizons beyond it can never read as high confidence.',
    'source', 'v_payables_lines + v_payables_payment_history + observed obligation-creation history'
  ),
  'unscheduled', (
    SELECT jsonb_build_object(
             'items',      COALESCE(SUM(c), 0),
             'amount',     COALESCE(SUM(amt), 0),
             'by_product', COALESCE(jsonb_object_agg(product_key, amt), '{}'::jsonb),
             'note',       'Payable on demand. Included in Total Payables, excluded from the forecast timeline: no contractual due date and no daily amount to project from.')
      FROM (SELECT product_key, ROUND(SUM(outstanding_amount), 2) AS amt, COUNT(*) AS c
              FROM v_payables_lines
             WHERE (due_kind = 'projected' AND COALESCE(daily_amount, 0) <= 0)
                OR (due_kind = 'scheduled' AND due_date IS NULL)
             GROUP BY product_key) q
  )
)
  INTO v_result;

  RETURN v_result;
END;
$function$;

DROP FUNCTION IF EXISTS public.get_landlord_payables_by_week(date, boolean);
DROP VIEW IF EXISTS public.v_landlord_float_payables;
DROP VIEW IF EXISTS public.v_landlord_payout_settlement;

REVOKE ALL ON public.v_payables_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_payables_lines TO service_role;
REVOKE ALL ON public.v_payables_payment_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_payables_payment_history TO service_role;

RESET lock_timeout;
