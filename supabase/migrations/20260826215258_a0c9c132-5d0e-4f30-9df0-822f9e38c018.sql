-- ============================================================
-- PAYABLES: authoritative definition + reporting RPCs (additive, read-only)
-- Mirrors the receivables layer exactly. No existing object is modified.
-- ============================================================

CREATE OR REPLACE FUNCTION public.payables_guard()
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT (
       has_role(v_uid,'cfo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
    OR has_role(v_uid,'manager') OR has_role(v_uid,'financial_ops')
    OR has_role(v_uid,'super_admin') OR has_role(v_uid,'cto')
  ) THEN
    RAISE EXCEPTION 'Not authorised to view payables' USING ERRCODE = '42501';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.payables_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payables_guard() FROM anon;
GRANT EXECUTE ON FUNCTION public.payables_guard() TO authenticated, service_role;

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
    ('other','Unclassified / Other',6)
  ) f(category_key, category_label, sort_order)
$function$;

REVOKE ALL ON FUNCTION public.payables_category_frame() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payables_category_frame() TO authenticated, service_role;

-- ---------- Authoritative payables lines ----------
CREATE OR REPLACE VIEW public.v_payables_lines AS
  -- Withdrawal requests in flight (money already claimed by users)
  SELECT 'user'::text AS category_key,
         'User Wallets & Withdrawals'::text AS category_label,
         'withdrawal_request'::text AS product_key,
         'Withdrawal Requests In Flight'::text AS product_label,
         'withdrawal_requests'::text AS source_table,
         w.id AS item_id,
         w.user_id AS counterparty_id,
         COALESCE(p.full_name, 'Unknown user') AS counterparty_name,
         GREATEST(COALESCE(w.amount,0)::numeric, 0) AS outstanding_amount,
         (w.created_at AT TIME ZONE 'Africa/Nairobi')::date AS due_date,
         'scheduled'::text AS due_kind,
         0::numeric AS daily_amount,
         w.status,
         w.created_at
  FROM withdrawal_requests w
  LEFT JOIN profiles p ON p.id = w.user_id
  WHERE w.status IN ('pending','approved','processing','re_approved_for_recovery')
    AND COALESCE(w.amount,0) > 0

  UNION ALL
  -- Withdrawable wallet balances (owed to users on demand)
  SELECT 'user','User Wallets & Withdrawals','wallet_balance','Withdrawable Wallet Balances',
         'wallets', wl.id, wl.user_id,
         COALESCE(p.full_name,'Unknown user'),
         GREATEST(COALESCE(wl.withdrawable_balance,0)::numeric,0),
         NULL::date, 'projected', 0::numeric, 'available', wl.created_at
  FROM wallets wl
  LEFT JOIN profiles p ON p.id = wl.user_id
  WHERE COALESCE(wl.withdrawable_balance,0) > 0

  UNION ALL
  -- Supporter returns due on the next payout date
  SELECT 'partner','Supporter Returns & Capital','supporter_returns','Supporter Returns Due',
         'investor_portfolios', ip.id, ip.investor_id,
         COALESCE(p.full_name,'Unknown supporter'),
         GREATEST(ROUND(COALESCE(ip.investment_amount,0) * COALESCE(ip.roi_percentage,0) / 100.0, 2), 0),
         ip.next_roi_date, 'scheduled', 0::numeric, ip.status, ip.created_at
  FROM investor_portfolios ip
  LEFT JOIN profiles p ON p.id = ip.investor_id
  WHERE ip.status = 'active'
    AND ip.next_roi_date IS NOT NULL
    AND COALESCE(ip.investment_amount,0) * COALESCE(ip.roi_percentage,0) > 0

  UNION ALL
  -- Portfolio principal repayable at maturity
  SELECT 'partner','Supporter Returns & Capital','portfolio_maturity','Portfolio Capital At Maturity',
         'investor_portfolios.maturity', ip.id, ip.investor_id,
         COALESCE(p.full_name,'Unknown supporter'),
         GREATEST(COALESCE(ip.investment_amount,0)::numeric,0),
         ip.maturity_date, 'scheduled', 0::numeric, ip.status, ip.created_at
  FROM investor_portfolios ip
  LEFT JOIN profiles p ON p.id = ip.investor_id
  WHERE ip.status = 'active'
    AND ip.maturity_date IS NOT NULL
    AND COALESCE(ip.investment_amount,0) > 0

  UNION ALL
  -- Landlord rent payouts awaiting settlement
  SELECT 'landlord','Landlord Rent Payouts','landlord_payout','Landlord Payouts Outstanding',
         'landlord_payouts', lp.id, lp.landlord_id,
         COALESCE(NULLIF(lp.landlord_name,''), p.full_name, 'Unknown landlord'),
         GREATEST(COALESCE(lp.amount,0)::numeric,0),
         (lp.created_at AT TIME ZONE 'Africa/Nairobi')::date, 'scheduled', 0::numeric, lp.status, lp.created_at
  FROM landlord_payouts lp
  LEFT JOIN profiles p ON p.id = lp.landlord_id
  WHERE lp.status IN ('awaiting_agent_receipt','pending_merchant_payout','failed','pending')
    AND COALESCE(lp.amount,0) > 0

  UNION ALL
  -- Agent-facilitated landlord payouts pending approval/settlement
  SELECT 'landlord','Landlord Rent Payouts','agent_landlord_payout','Agent Landlord Payouts Pending',
         'agent_landlord_payouts', ap.id, ap.landlord_id,
         COALESCE(NULLIF(ap.landlord_name,''), p.full_name, 'Unknown landlord'),
         GREATEST(COALESCE(ap.amount,0)::numeric,0),
         (ap.created_at AT TIME ZONE 'Africa/Nairobi')::date, 'scheduled', 0::numeric, ap.status, ap.created_at
  FROM agent_landlord_payouts ap
  LEFT JOIN profiles p ON p.id = ap.landlord_id
  WHERE ap.status IN ('pending','landlord_ops_approved','cfo_pending')
    AND COALESCE(ap.amount,0) > 0

  UNION ALL
  -- Agent commission payouts awaiting payment
  SELECT 'agent','Agent Payables','agent_commission_payout','Agent Commission Payouts',
         'agent_commission_payouts', cp.id, cp.agent_id,
         COALESCE(p.full_name,'Unknown agent'),
         GREATEST(COALESCE(cp.amount,0)::numeric,0),
         (cp.requested_at AT TIME ZONE 'Africa/Nairobi')::date, 'scheduled', 0::numeric, cp.status, cp.created_at
  FROM agent_commission_payouts cp
  LEFT JOIN profiles p ON p.id = cp.agent_id
  WHERE cp.status IN ('pending','approved')
    AND COALESCE(cp.amount,0) > 0

  UNION ALL
  -- Agent float withdrawals in flight
  SELECT 'agent','Agent Payables','agent_float_withdrawal','Agent Float Withdrawals In Flight',
         'agent_float_withdrawals', fw.id, fw.agent_id,
         COALESCE(p.full_name,'Unknown agent'),
         GREATEST(COALESCE(fw.amount,0)::numeric,0),
         (fw.created_at AT TIME ZONE 'Africa/Nairobi')::date, 'scheduled', 0::numeric, fw.status, fw.created_at
  FROM agent_float_withdrawals fw
  LEFT JOIN profiles p ON p.id = fw.agent_id
  WHERE fw.status IN ('pending','agent_ops_approved','manager_approved','processing')
    AND COALESCE(fw.amount,0) > 0

  UNION ALL
  -- Payroll disbursements not yet paid out
  SELECT 'staff','Payroll & Staff','payroll_disbursement','Payroll Disbursements Pending',
         'hr_pay_disbursements', d.id, d.user_id,
         COALESCE(p.full_name,'Staff member'),
         GREATEST(COALESCE(d.amount,0)::numeric,0),
         (d.created_at AT TIME ZONE 'Africa/Nairobi')::date, 'scheduled', 0::numeric, d.status, d.created_at
  FROM hr_pay_disbursements d
  LEFT JOIN profiles p ON p.id = d.user_id
  WHERE COALESCE(d.status,'') NOT IN ('posted','cancelled','reversed')
    AND COALESCE(d.amount,0) > 0;

REVOKE ALL ON public.v_payables_lines FROM PUBLIC;
REVOKE ALL ON public.v_payables_lines FROM anon;
REVOKE ALL ON public.v_payables_lines FROM authenticated;
GRANT SELECT ON public.v_payables_lines TO service_role;

-- ---------- Shared observed payment history (forecast AND back-test read this) ----------
CREATE OR REPLACE VIEW public.v_payables_payment_history AS
  SELECT 'user'::text AS category_key, 'withdrawal_request'::text AS product_key,
         (COALESCE(w.processed_at, w.updated_at) AT TIME ZONE 'Africa/Nairobi')::date AS d,
         COALESCE(w.amount,0)::numeric AS amount
  FROM withdrawal_requests w
  WHERE w.status IN ('completed','paid') AND COALESCE(w.processed_at, w.updated_at) IS NOT NULL
  UNION ALL
  SELECT 'partner','supporter_returns',(g.transaction_date AT TIME ZONE 'Africa/Nairobi')::date, COALESCE(g.amount,0)
  FROM general_ledger g
  WHERE g.direction='cash_out' AND g.ledger_scope='platform' AND g.category='roi_expense'
  UNION ALL
  SELECT 'landlord','landlord_payout',(g.transaction_date AT TIME ZONE 'Africa/Nairobi')::date, COALESCE(g.amount,0)
  FROM general_ledger g
  WHERE g.direction='cash_out' AND g.ledger_scope='platform' AND g.category='rent_disbursement'
  UNION ALL
  SELECT 'landlord','agent_landlord_payout',(g.transaction_date AT TIME ZONE 'Africa/Nairobi')::date, COALESCE(g.amount,0)
  FROM general_ledger g
  WHERE g.direction='cash_out' AND g.ledger_scope='platform' AND g.category='agent_landlord_payout'
  UNION ALL
  SELECT 'agent','agent_commission_payout',(g.transaction_date AT TIME ZONE 'Africa/Nairobi')::date, COALESCE(g.amount,0)
  FROM general_ledger g
  WHERE g.direction='cash_out' AND g.ledger_scope='platform' AND g.category='agent_commission_payable'
  UNION ALL
  SELECT 'staff','payroll_disbursement',(g.transaction_date AT TIME ZONE 'Africa/Nairobi')::date, COALESCE(g.amount,0)
  FROM general_ledger g
  WHERE g.direction='cash_out' AND g.ledger_scope='platform' AND g.category='salary_payout';

REVOKE ALL ON public.v_payables_payment_history FROM PUBLIC;
REVOKE ALL ON public.v_payables_payment_history FROM anon;
REVOKE ALL ON public.v_payables_payment_history FROM authenticated;
GRANT SELECT ON public.v_payables_payment_history TO service_role;

-- ---------- Authoritative total ----------
CREATE OR REPLACE FUNCTION public.get_payables_total()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_result jsonb;
BEGIN
  PERFORM payables_guard();

  SELECT jsonb_build_object(
    'currency','UGX',
    'as_at', now(),
    'total', COALESCE((SELECT ROUND(SUM(outstanding_amount),2) FROM v_payables_lines),0),
    'item_count', COALESCE((SELECT COUNT(*) FROM v_payables_lines),0),
    'overdue', COALESCE((SELECT ROUND(SUM(outstanding_amount),2) FROM v_payables_lines
                          WHERE due_date IS NOT NULL AND due_date < (now() AT TIME ZONE 'Africa/Nairobi')::date),0),
    'due_today', COALESCE((SELECT ROUND(SUM(outstanding_amount),2) FROM v_payables_lines
                          WHERE due_date = (now() AT TIME ZONE 'Africa/Nairobi')::date),0),
    'categories', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'key', c.category_key, 'label', c.category_label,
               'outstanding', c.outstanding, 'item_count', c.item_count
             ) ORDER BY c.sort_order)
      FROM (
        SELECT f.category_key, f.category_label, f.sort_order,
               ROUND(COALESCE(SUM(l.outstanding_amount),0),2) AS outstanding,
               COUNT(l.item_id) AS item_count
        FROM payables_category_frame() f
        LEFT JOIN v_payables_lines l ON l.category_key = f.category_key
        GROUP BY f.category_key, f.category_label, f.sort_order
      ) c
    ), '[]'::jsonb),
    'source','v_payables_lines'
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_payables_total() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_payables_total() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_payables_total() TO authenticated, service_role;

-- ---------- Category -> product -> item drill-down ----------
CREATE OR REPLACE FUNCTION public.get_payables_breakdown()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_total numeric := 0;
  v_cats jsonb := '[]'::jsonb;
  v_cat_total numeric := 0;
BEGIN
  PERFORM payables_guard();

  SELECT COALESCE(ROUND(SUM(outstanding_amount),2),0) INTO v_total FROM v_payables_lines;

  WITH ranked AS (
    SELECT l.*, ROW_NUMBER() OVER (PARTITION BY l.product_key ORDER BY l.outstanding_amount DESC) AS rn
    FROM v_payables_lines l
  ), products AS (
    SELECT category_key, product_key, product_label, source_table,
           ROUND(SUM(outstanding_amount),2) AS outstanding,
           COUNT(*) AS item_count,
           SUM(CASE WHEN due_kind = 'scheduled' THEN outstanding_amount ELSE 0 END) AS scheduled_amount,
           SUM(CASE WHEN due_kind = 'projected' THEN outstanding_amount ELSE 0 END) AS projected_amount,
           COALESCE(jsonb_agg(jsonb_build_object(
             'item_id', item_id, 'counterparty', counterparty_name,
             'amount', ROUND(outstanding_amount,2), 'due_date', due_date,
             'due_kind', due_kind, 'status', status, 'source', source_table
           ) ORDER BY outstanding_amount DESC) FILTER (WHERE rn <= 100), '[]'::jsonb) AS items
    FROM ranked
    GROUP BY category_key, product_key, product_label, source_table
  )
  SELECT jsonb_agg(jsonb_build_object(
           'key', f.category_key, 'label', f.category_label,
           'outstanding', ROUND(COALESCE(c.outstanding,0),2),
           'item_count', COALESCE(c.item_count,0),
           'products', COALESCE(c.products,'[]'::jsonb)
         ) ORDER BY f.sort_order),
         COALESCE(SUM(c.outstanding),0)
    INTO v_cats, v_cat_total
  FROM payables_category_frame() f
  LEFT JOIN (
    SELECT category_key,
           SUM(outstanding) AS outstanding,
           SUM(item_count) AS item_count,
           jsonb_agg(jsonb_build_object(
             'key', product_key, 'label', product_label, 'source', source_table,
             'outstanding', outstanding, 'item_count', item_count,
             'scheduled_amount', ROUND(scheduled_amount,2),
             'projected_amount', ROUND(projected_amount,2),
             'items', items
           ) ORDER BY outstanding DESC) AS products
    FROM products GROUP BY category_key
  ) c ON c.category_key = f.category_key;

  RETURN jsonb_build_object(
    'currency','UGX', 'as_at', now(),
    'total', v_total,
    'categories', COALESCE(v_cats,'[]'::jsonb),
    'validation', jsonb_build_object(
      'categories_total', ROUND(v_cat_total,2),
      'authoritative_total', v_total,
      'difference', ROUND(v_cat_total - v_total, 2),
      'ties_out', abs(v_cat_total - v_total) < 0.01
    ),
    'source','v_payables_lines'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_payables_breakdown() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_payables_breakdown() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_payables_breakdown() TO authenticated, service_role;

-- ---------- Predictive forecast ----------
CREATE OR REPLACE FUNCTION public.get_payables_predictive_forecast(
  p_granularity text DEFAULT 'month',
  p_periods integer DEFAULT 12,
  p_as_at date DEFAULT NULL
)
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
  )
)
  INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_payables_predictive_forecast(text, integer, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_payables_predictive_forecast(text, integer, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_payables_predictive_forecast(text, integer, date) TO authenticated, service_role;

-- ---------- Walk-forward back-test ----------
CREATE OR REPLACE FUNCTION public.get_payables_forecast_accuracy(
  p_origins integer DEFAULT 8,
  p_step_days integer DEFAULT 7,
  p_horizons integer[] DEFAULT ARRAY[1,7,30]
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Nairobi')::date;
  v_origins integer := LEAST(GREATEST(COALESCE(p_origins, 8), 1), 24);
  v_step integer := LEAST(GREATEST(COALESCE(p_step_days, 7), 1), 30);
  v_hz integer[];
  v_max integer;
  v_first_hist date;
  v_origin date;
  v_fc jsonb;
  v_periods jsonb;
  v_h integer;
  v_i integer;
  v_runs jsonb := '[]'::jsonb;
  v_fcast numeric;
  v_low numeric;
  v_high numeric;
  v_products jsonb;
  v_result jsonb;
BEGIN
  PERFORM payables_guard();

  SELECT array_agg(DISTINCT LEAST(GREATEST(x, 1), 59) ORDER BY LEAST(GREATEST(x, 1), 59))
    INTO v_hz FROM unnest(COALESCE(p_horizons, ARRAY[1,7,30])) x;
  IF v_hz IS NULL OR array_length(v_hz, 1) IS NULL THEN v_hz := ARRAY[1,7,30]; END IF;
  v_max := v_hz[array_length(v_hz, 1)];

  SELECT MIN(d) INTO v_first_hist FROM v_payables_payment_history WHERE amount > 0;

  IF v_first_hist IS NOT NULL THEN
    FOR v_i IN 0..(v_origins - 1) LOOP
      v_origin := v_today - v_max - (v_i * v_step);
      EXIT WHEN v_origin < v_first_hist + 21;

      v_fc := get_payables_predictive_forecast('day', v_max + 1, v_origin);
      v_periods := COALESCE(v_fc->'periods', '[]'::jsonb);

      FOREACH v_h IN ARRAY v_hz LOOP
        SELECT
          COALESCE(SUM(m.modelled), 0),
          COALESCE(SUM(m.modelled * CASE WHEN (t.pe->>'forecast_amount')::numeric > 0
              THEN (t.pe->>'low')::numeric / (t.pe->>'forecast_amount')::numeric ELSE 0.5 END), 0),
          COALESCE(SUM(m.modelled * CASE WHEN (t.pe->>'forecast_amount')::numeric > 0
              THEN (t.pe->>'high')::numeric / (t.pe->>'forecast_amount')::numeric ELSE 1.5 END), 0)
        INTO v_fcast, v_low, v_high
        FROM jsonb_array_elements(v_periods) WITH ORDINALITY t(pe, ord)
        CROSS JOIN LATERAL (
          SELECT COALESCE(SUM((s->>'amount')::numeric), 0) AS modelled
          FROM jsonb_array_elements(t.pe->'sources') s
          WHERE s->>'basis' = 'modelled'
        ) m
        WHERE t.ord BETWEEN 2 AND v_h + 1;

        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'category_key', q.ck, 'category_label', q.cl,
                 'product_key', q.pk, 'product_label', q.pl, 'forecast', ROUND(q.amt, 2))), '[]'::jsonb)
          INTO v_products
        FROM (
          SELECT s->>'category_key' ck, MAX(s->>'category_label') cl,
                 s->>'product_key' pk, MAX(s->>'product_label') pl,
                 SUM((s->>'amount')::numeric) amt
          FROM jsonb_array_elements(v_periods) WITH ORDINALITY t(pe, ord),
               jsonb_array_elements(t.pe->'sources') s
          WHERE t.ord BETWEEN 2 AND v_h + 1 AND s->>'basis' = 'modelled'
          GROUP BY 1, 3
        ) q;

        v_runs := v_runs || jsonb_build_array(jsonb_build_object(
          'origin', v_origin, 'horizon', v_h,
          'window_from', v_origin + 1, 'window_to', v_origin + v_h,
          'forecast', ROUND(v_fcast, 2), 'low', ROUND(v_low, 2), 'high', ROUND(v_high, 2),
          'products', v_products));
      END LOOP;
    END LOOP;
  END IF;

  WITH runs AS (
    SELECT (r->>'origin')::date origin, (r->>'horizon')::int horizon,
           (r->>'window_from')::date wf, (r->>'window_to')::date wt,
           (r->>'forecast')::numeric forecast, (r->>'low')::numeric low, (r->>'high')::numeric high,
           r->'products' products
    FROM jsonb_array_elements(v_runs) r
  ), graded AS (
    SELECT r.*,
      COALESCE((SELECT SUM(h.amount) FROM v_payables_payment_history h
                WHERE h.d BETWEEN r.wf AND r.wt AND h.amount > 0), 0) AS actual
    FROM runs r
  ), scored AS (
    SELECT g.*,
      CASE WHEN g.actual > 0 THEN ABS(g.forecast - g.actual) / g.actual END AS ape,
      CASE WHEN g.actual > 0 THEN (g.forecast - g.actual) / g.actual END AS pe,
      (g.actual >= g.low AND g.actual <= g.high) AS in_band
    FROM graded g
  ), by_h AS (
    SELECT horizon, COUNT(*) runs,
      ROUND(AVG(ape) FILTER (WHERE ape IS NOT NULL) * 100, 1) AS mape_pct,
      ROUND((1 - LEAST(1, COALESCE(AVG(ape) FILTER (WHERE ape IS NOT NULL), 1))) * 100, 1) AS accuracy_pct,
      ROUND(AVG(pe) FILTER (WHERE pe IS NOT NULL) * 100, 1) AS bias_pct,
      ROUND(AVG(CASE WHEN in_band THEN 1 ELSE 0 END) * 100, 1) AS band_hit_pct,
      ROUND(SUM(forecast), 2) total_forecast, ROUND(SUM(actual), 2) total_actual
    FROM scored GROUP BY horizon
  ), prod_runs AS (
    SELECT s.origin, s.horizon, s.wf, s.wt,
      p->>'category_key' ck, p->>'category_label' cl,
      p->>'product_key' pk, p->>'product_label' pl, (p->>'forecast')::numeric forecast
    FROM scored s, jsonb_array_elements(s.products) p
  ), prod_scored AS (
    SELECT pr.*,
      COALESCE((SELECT SUM(h.amount) FROM v_payables_payment_history h
                WHERE h.category_key = pr.ck AND h.product_key = pr.pk
                  AND h.d BETWEEN pr.wf AND pr.wt AND h.amount > 0), 0) AS actual
    FROM prod_runs pr
  ), by_prod AS (
    SELECT ck, MAX(cl) cl, pk, MAX(pl) pl, horizon, COUNT(*) runs,
      ROUND(AVG(CASE WHEN actual > 0 THEN ABS(forecast - actual) / actual END) * 100, 1) AS mape_pct,
      ROUND((1 - LEAST(1, COALESCE(AVG(CASE WHEN actual > 0 THEN ABS(forecast - actual) / actual END), 1))) * 100, 1) AS accuracy_pct,
      ROUND(AVG(CASE WHEN actual > 0 THEN (forecast - actual) / actual END) * 100, 1) AS bias_pct,
      ROUND(SUM(forecast), 2) total_forecast, ROUND(SUM(actual), 2) total_actual
    FROM prod_scored GROUP BY ck, pk, horizon
  )
  SELECT jsonb_build_object(
    'currency', 'UGX',
    'as_at', v_today,
    'timezone', 'Africa/Nairobi',
    'horizons', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'horizon_days', horizon, 'runs', runs, 'accuracy_pct', accuracy_pct,
        'mape_pct', mape_pct, 'bias_pct', bias_pct, 'band_hit_pct', band_hit_pct,
        'total_forecast', total_forecast, 'total_actual', total_actual) ORDER BY horizon)
      FROM by_h), '[]'::jsonb),
    'series', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'origin', origin, 'horizon_days', horizon,
        'window_from', wf, 'window_to', wt,
        'forecast', forecast, 'actual', actual, 'low', low, 'high', high,
        'error_pct', ROUND(pe * 100, 1), 'in_band', in_band) ORDER BY horizon, origin)
      FROM scored), '[]'::jsonb),
    'products', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'category_key', ck, 'category_label', cl, 'product_key', pk, 'product_label', pl,
        'horizon_days', horizon, 'runs', runs, 'accuracy_pct', accuracy_pct,
        'mape_pct', mape_pct, 'bias_pct', bias_pct,
        'total_forecast', total_forecast, 'total_actual', total_actual) ORDER BY horizon, total_actual DESC)
      FROM by_prod), '[]'::jsonb),
    'meta', jsonb_build_object(
      'origins_requested', v_origins,
      'origins_used', (SELECT COUNT(DISTINCT origin) FROM runs),
      'step_days', v_step,
      'horizon_days', to_jsonb(v_hz),
      'first_history_date', v_first_hist,
      'model_version', 'payables runoff+obligations v1 (2026-08-26)',
      'method_note', 'Walk-forward replay: the live payables forecasting model is re-run with an as-at date set to each past origin, so it only sees data available on that date, and its predicted payments for the following window are compared with what was actually paid. Only modelled streams are graded; streams carried at contractual due dates are excluded. Replay reads outstanding balances as of today, so it is a slightly optimistic upper bound on true out-of-sample accuracy.',
      'source', 'get_payables_predictive_forecast replayed over v_payables_payment_history'
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_payables_forecast_accuracy(integer, integer, integer[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_payables_forecast_accuracy(integer, integer, integer[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_payables_forecast_accuracy(integer, integer, integer[]) TO authenticated, service_role;