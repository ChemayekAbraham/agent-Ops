-- Applied directly to production 2026-10-22 (migration tool failed with 42P10).
-- Read-only report speed-up: each payables source view is read once per call; JIT off. Figures and rules unchanged.
CREATE OR REPLACE FUNCTION public.get_payables_predictive_forecast(p_granularity text DEFAULT 'month'::text, p_periods integer DEFAULT 12, p_as_at date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET jit TO 'off'
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

WITH payables_lines_snap AS MATERIALIZED (SELECT * FROM v_payables_lines),
float_payables_snap AS MATERIALIZED (SELECT * FROM v_landlord_float_payables),
payout_settlement_snap AS MATERIALIZED (SELECT * FROM v_landlord_payout_settlement),
params AS (
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
  -- Payables scope (CFO, 2026-10-21): no landlord run-off stream. The landlord payable is the weekly float line, carried
  -- at its scheduled date; landlord payment history stays in 'history' (actual payments) only.
  SELECT ck, pk, MIN(d) first_d, COUNT(*) sample_days FROM hist WHERE ck <> 'landlord' GROUP BY 1,2
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
  -- one label per (category, product): the period totals join here, so a second label must never duplicate a row
  SELECT DISTINCT ON (category_key, product_key) category_key ck, category_label cl, product_key pk, product_label pl
    FROM payables_lines_snap ORDER BY category_key, product_key, product_label
), outs AS (
  SELECT category_key ck, product_key pk, ROUND(SUM(outstanding_amount),2) outstanding
  FROM payables_lines_snap GROUP BY 1,2
), orig_raw AS (
  -- New obligations created, per day, from the obligation tables themselves
  -- Payables scope (CFO, 2026-10-21): only Supporter Returns and agent commissions originate here. Withdrawal
  -- requests and payroll are no longer payables; the landlord payable is the weekly float line (scheduled at the end of
  -- its week below), so per-payout landlord originations would count it twice.
  SELECT 'agent'::text ck, 'agent_commission_payout'::text pk,
         (cp.created_at AT TIME ZONE 'Africa/Nairobi')::date d, COALESCE(cp.amount,0)::numeric amt
  FROM agent_commission_payouts cp
  WHERE cp.status <> 'rejected'
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
  -- Payables scope (CFO, 2026-10-21): a scheduled item already past its due date and still outstanding is carried into
  -- the period that contains today (basis 'overdue') until it is settled, so an ended landlord float or a past-due
  -- budget line never drops out of the forecast. Each line lands in exactly one period; zero-value lines are skipped.
  SELECT pr.i, l.category_key ck, l.product_key pk,
         CASE WHEN l.due_date < (SELECT today FROM params) THEN 'overdue' ELSE 'scheduled' END AS basis,
         ROUND(SUM(l.outstanding_amount),2) amt
  FROM payables_lines_snap l
  JOIN periods pr ON GREATEST(l.due_date, (SELECT today FROM params))
                     BETWEEN GREATEST(pr.period_start, (SELECT today FROM params)) AND pr.period_end
  WHERE l.due_date IS NOT NULL AND l.outstanding_amount <> 0
    AND NOT EXISTS (SELECT 1 FROM model m WHERE m.ck=l.category_key AND m.pk=l.product_key AND m.method <> 'insufficient_data')
  GROUP BY 1,2,3,4
), combined AS (
  SELECT i, ck, pk, (runoff + new_orig) AS total, runoff, new_orig, 'modelled'::text basis FROM modelled
  UNION ALL
  SELECT i, ck, pk, amt, amt, 0, basis FROM sched
), hist_span AS (
  SELECT GREATEST(1, (SELECT today FROM params) - MIN(d)) AS span_days FROM hist
), per_period AS (
  SELECT c.i, ROUND(SUM(c.total),2) total, ROUND(SUM(c.runoff),2) runoff, ROUND(SUM(c.new_orig),2) new_orig,
    ROUND(COALESCE(SUM(c.total * COALESCE(m.mape, 0.5)::numeric) FILTER (WHERE c.basis='modelled')
      / NULLIF(SUM(c.total) FILTER (WHERE c.basis='modelled'), 0), 0.5)::numeric, 4) AS wmape,
    ROUND(COALESCE(SUM(c.total) FILTER (WHERE c.basis IN ('scheduled','overdue')),0),2) AS scheduled_total,
    ROUND(COALESCE(SUM(c.total) FILTER (WHERE c.basis='overdue'),0),2) AS overdue_total,
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
    pp.scheduled_total, pp.overdue_total, pp.sources, p.today, p.gran, hs.span_days,
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
    'overdue_carried_amount', COALESCE(q.overdue_total,0),
    'low', ROUND(COALESCE(q.total,0) * (1 - LEAST(0.6, GREATEST(0.1, COALESCE(q.wmape,0.5)))),2),
    'high', ROUND(COALESCE(q.total,0) * (1 + LEAST(0.6, GREATEST(0.1, COALESCE(q.wmape,0.5)))),2),
    'confidence', LEAST(
        CASE q.quality WHEN 'low' THEN 0.35 WHEN 'medium' THEN 0.6 WHEN 'insufficient' THEN 0.05 ELSE 0.95 END,
        ROUND(GREATEST(0.05, LEAST(0.95, (1 - COALESCE(q.wmape,0.5))
          * (1.0 / (1 + q.horizon_days::numeric / 365.0)))),3)),
    'quality', q.quality,
    'quality_reason', q.quality_reason,
    'is_forecast', true,
    'sources', COALESCE(q.sources, '[]'::jsonb),
    'landlord_float', (SELECT jsonb_build_object(
        'weeks', count(*),
        'weeks_with_float', count(lf.week_start),
        'weeks_without_float', COALESCE(jsonb_agg(g.wk::date ORDER BY g.wk) FILTER (WHERE lf.week_start IS NULL), '[]'::jsonb),
        'float_outstanding', COALESCE(sum(lf.outstanding_amount), 0),
        'landlord_not_estimated', COALESCE(bool_or(lf.week_start IS NULL), false))
      FROM generate_series(public.landlord_float_week_start(GREATEST(q.period_start, q.today)), q.period_end, interval '1 week') g(wk)
      LEFT JOIN float_payables_snap lf ON lf.week_start = g.wk::date
     WHERE (g.wk::date + 6) BETWEEN GREATEST(q.period_start, q.today) AND q.period_end)
      || jsonb_build_object('overdue_float_outstanding',
           CASE WHEN q.today BETWEEN q.period_start AND q.period_end
                THEN (SELECT COALESCE(sum(ovf.outstanding_amount), 0) FROM float_payables_snap ovf WHERE ovf.week_end < q.today)
                ELSE 0 END)
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
             FROM payables_lines_snap GROUP BY 1) c), '[]'::jsonb)
  ) j FROM payables_lines_snap
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
  'reconciliation', (
    SELECT jsonb_build_object(
             'payables_total', x.total, 'forecast_book_runoff', x.runoff, 'of_which_overdue_carried', x.overdue,
             'modelled_not_run_off_in_horizon', x.not_run_off, 'no_due_date', x.no_due, 'due_after_horizon', x.after_h,
             'new_originations_not_in_list', x.new_orig,
             'difference', x.total - (x.runoff + x.not_run_off + x.no_due + x.after_h))
      FROM (SELECT
              (SELECT ROUND(COALESCE(SUM(outstanding_amount),0),2) FROM payables_lines_snap) AS total,
              (SELECT ROUND(COALESCE(SUM(runoff),0),2) FROM per_period) AS runoff,          -- the period totals people see
              (SELECT ROUND(COALESCE(SUM(overdue_total),0),2) FROM per_period) AS overdue,
              (SELECT ROUND(COALESCE(SUM(o.outstanding),0),2) FROM outs o
                WHERE EXISTS (SELECT 1 FROM model m WHERE m.ck=o.ck AND m.pk=o.pk AND m.method <> 'insufficient_data'))
                - (SELECT ROUND(COALESCE(SUM(c.runoff),0),2) FROM combined c WHERE c.basis = 'modelled') AS not_run_off,
              (SELECT ROUND(COALESCE(SUM(l.outstanding_amount),0),2) FROM payables_lines_snap l WHERE l.due_date IS NULL
                  AND NOT EXISTS (SELECT 1 FROM model m WHERE m.ck=l.category_key AND m.pk=l.product_key AND m.method <> 'insufficient_data')) AS no_due,
              (SELECT ROUND(COALESCE(SUM(l.outstanding_amount),0),2) FROM payables_lines_snap l WHERE l.due_date > (SELECT MAX(period_end) FROM periods)
                  AND NOT EXISTS (SELECT 1 FROM model m WHERE m.ck=l.category_key AND m.pk=l.product_key AND m.method <> 'insufficient_data')) AS after_h,
              (SELECT ROUND(COALESCE(SUM(new_orig),0),2) FROM per_period) AS new_orig) x
  ),
  'landlord_coverage', (
    SELECT jsonb_build_object(
             'basis', 'weekly_landlord_float',
             'note', 'Landlord payables are recorded per weekly landlord float set by the CFO. A week without a weekly float carries no landlord amount in this forecast: its landlord obligations are not estimated, which does not mean there are none. A float whose week has ended stays in the forecast, carried into the current period as overdue, until its payouts are verified or it is otherwise resolved. After a float''s week ends only its approved payouts not yet verified stay payable; its unused allowance lapses (lapsed_unused_float_allowance) and is never payable. Payouts approved but not yet paid out that sit in no weekly float are owed: they are carried on their own (approved_no_float_outstanding) from their approval date until paid out, including a still-funded rent request whose last payout attempt failed (a failed attempt is not a payment). Landlord payouts made without a weekly float and not verified by the Receipt Archive are held for CFO review (historical review) and are outside the payables and this forecast.',
             'weeks_in_horizon', (c.j->>'weeks')::int,
             'weeks_with_float', (c.j->>'weeks_with_float')::int,
             'weeks_without_float', c.j->'weeks_without_float',
             'landlord_not_estimated', (c.j->>'landlord_not_estimated')::boolean,
             'float_outstanding', (c.j->>'float_outstanding')::numeric,
             'historical_review_count', (SELECT count(*) FROM payout_settlement_snap WHERE state = 'historical_review'),
             'historical_review_amount', (SELECT COALESCE(sum(amount), 0) FROM payout_settlement_snap WHERE state = 'historical_review'),
             'overdue_floats', (SELECT COALESCE(jsonb_agg(jsonb_build_object('week_start', ovf.week_start, 'week_end', ovf.week_end,
                                        'outstanding', ovf.outstanding_amount, 'unverified_paid', ovf.unverified_paid) ORDER BY ovf.week_start), '[]'::jsonb)
                                  FROM float_payables_snap ovf WHERE ovf.week_end < (SELECT today FROM params) AND ovf.outstanding_amount > 0),
             'overdue_float_outstanding', (SELECT COALESCE(sum(ovf.outstanding_amount), 0) FROM float_payables_snap ovf
                                            WHERE ovf.week_end < (SELECT today FROM params)),
             'lapsed_unused_float_allowance', (SELECT COALESCE(sum(ovf.lapsed_unused), 0) FROM float_payables_snap ovf),
             'approved_no_float_count', (SELECT count(*) FROM payout_settlement_snap WHERE approved_no_float),
             'approved_no_float_outstanding', (SELECT COALESCE(sum(amount), 0) FROM payout_settlement_snap WHERE approved_no_float))
      FROM (SELECT (SELECT jsonb_build_object(
        'weeks', count(*),
        'weeks_with_float', count(lf.week_start),
        'weeks_without_float', COALESCE(jsonb_agg(g.wk::date ORDER BY g.wk) FILTER (WHERE lf.week_start IS NULL), '[]'::jsonb),
        'float_outstanding', COALESCE(sum(lf.outstanding_amount), 0),
        'landlord_not_estimated', COALESCE(bool_or(lf.week_start IS NULL), false))
      FROM generate_series(public.landlord_float_week_start((SELECT today FROM params)), (SELECT MAX(period_end) FROM periods), interval '1 week') g(wk)
      LEFT JOIN float_payables_snap lf ON lf.week_start = g.wk::date
     WHERE (g.wk::date + 6) BETWEEN (SELECT today FROM params) AND (SELECT MAX(period_end) FROM periods)) j) c
  ),
  'unscheduled', (
    SELECT jsonb_build_object(
             'items',      COALESCE(SUM(c), 0),
             'amount',     COALESCE(SUM(amt), 0),
             'by_product', COALESCE(jsonb_object_agg(product_key, amt), '{}'::jsonb),
             'note',       'Payable on demand. Included in Total Payables, excluded from the forecast timeline: no contractual due date and no daily amount to project from.')
      FROM (SELECT product_key, ROUND(SUM(outstanding_amount), 2) AS amt, COUNT(*) AS c
              FROM payables_lines_snap
             WHERE (due_kind = 'projected' AND COALESCE(daily_amount, 0) <= 0)
                OR (due_kind = 'scheduled' AND due_date IS NULL)
             GROUP BY product_key) q
  )
)
  INTO v_result;

  RETURN v_result;
END;
$function$;
