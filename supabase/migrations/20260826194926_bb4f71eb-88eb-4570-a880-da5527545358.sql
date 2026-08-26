CREATE OR REPLACE FUNCTION public.get_receivables_predictive_forecast(
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
  PERFORM receivables_guard();
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
), hist_raw AS (
  SELECT 'tenant'::text ck,'rent_plan'::text pk,(created_at AT TIME ZONE 'Africa/Nairobi')::date d, COALESCE(amount,0) amt FROM agent_collections
  UNION ALL SELECT 'tenant','rent_plan',(created_at AT TIME ZONE 'Africa/Nairobi')::date, COALESCE(amount,0) FROM field_collections
  UNION ALL SELECT 'agent','agent_advance',date, COALESCE(amount_deducted,0) FROM agent_advance_ledger
  UNION ALL SELECT 'agent','credit_access_draw',date, COALESCE(amount_deducted,0) FROM credit_draw_ledger
  UNION ALL SELECT 'agent','merchandise_recovery',(created_at AT TIME ZONE 'Africa/Nairobi')::date, COALESCE(amount,0) FROM merchandise_recovery_deductions
  UNION ALL SELECT 'tenant','tenant_service_charge',COALESCE(charge_date,(created_at AT TIME ZONE 'Africa/Nairobi')::date), COALESCE(amount_deducted,0) FROM subscription_charge_logs
  UNION ALL SELECT 'other','business_advance',(created_at AT TIME ZONE 'Africa/Nairobi')::date, COALESCE(amount,0) FROM business_advance_repayments
), hist AS (
  SELECT h.ck, h.pk, h.d, SUM(h.amt) amt
  FROM hist_raw h CROSS JOIN params p
  WHERE h.d IS NOT NULL AND h.d > p.today - p.lookback AND h.d <= p.today AND h.amt > 0
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
  SELECT DISTINCT category_key ck, category_label cl, product_key pk, product_label pl FROM v_receivables_lines
), outs AS (
  SELECT category_key ck, product_key pk, ROUND(SUM(outstanding_amount),2) outstanding
  FROM v_receivables_lines GROUP BY 1,2
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
), fc_period AS (
  SELECT pr.i, df.ck, df.pk, ROUND(SUM(df.amt)::numeric,2) amt
  FROM day_fc df JOIN periods pr ON df.d BETWEEN pr.period_start AND pr.period_end
  GROUP BY 1,2,3
), fc_split AS (
  SELECT f.*, o.outstanding,
    SUM(f.amt) OVER (PARTITION BY f.ck, f.pk ORDER BY f.i) AS cum
  FROM fc_period f LEFT JOIN outs o ON o.ck=f.ck AND o.pk=f.pk
), fc_final AS (
  SELECT i, ck, pk, amt,
    ROUND(LEAST(cum, COALESCE(outstanding,0)) - LEAST(cum - amt, COALESCE(outstanding,0)), 2) AS runoff,
    ROUND(amt - (LEAST(cum, COALESCE(outstanding,0)) - LEAST(cum - amt, COALESCE(outstanding,0))), 2) AS new_orig
  FROM fc_split
), sched AS (
  SELECT pr.i, l.category_key ck, l.product_key pk, ROUND(SUM(l.outstanding_amount),2) amt
  FROM v_receivables_lines l
  JOIN periods pr ON l.due_date BETWEEN GREATEST(pr.period_start, (SELECT today FROM params)) AND pr.period_end
  WHERE l.due_date IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM model m WHERE m.ck=l.category_key AND m.pk=l.product_key AND m.method <> 'insufficient_data')
  GROUP BY 1,2,3
), combined AS (
  SELECT i, ck, pk, amt AS total, runoff, new_orig, 'modelled'::text basis FROM fc_final
  UNION ALL
  SELECT i, ck, pk, amt, amt, 0, 'scheduled'::text FROM sched
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
), periods_json AS (
  SELECT jsonb_agg(jsonb_build_object(
    'index', pr.i,
    'period_start', pr.period_start, 'period_end', pr.period_end,
    'forecast_from', GREATEST(pr.period_start, p.today),
    'is_partial_period', pr.period_start < p.today,
    'label', CASE p.gran
        WHEN 'day' THEN to_char(pr.period_start,'DD Mon')
        WHEN 'week' THEN 'Wk ' || to_char(pr.period_start,'IW YYYY')
        WHEN 'month' THEN to_char(pr.period_start,'Mon YYYY')
        WHEN 'quarter' THEN 'Q' || to_char(pr.period_start,'Q YYYY')
        ELSE to_char(pr.period_start,'YYYY') END,
    'forecast_amount', COALESCE(pp.total,0),
    'runoff_amount', COALESCE(pp.runoff,0),
    'new_origination_amount', COALESCE(pp.new_orig,0),
    'scheduled_amount', COALESCE(pp.scheduled_total,0),
    'low', ROUND(COALESCE(pp.total,0) * (1 - LEAST(0.6, GREATEST(0.1, COALESCE(pp.wmape,0.5)))),2),
    'high', ROUND(COALESCE(pp.total,0) * (1 + LEAST(0.6, GREATEST(0.1, COALESCE(pp.wmape,0.5)))),2),
    'confidence', ROUND(GREATEST(0.05, LEAST(0.95, (1 - COALESCE(pp.wmape,0.5))
        * (1.0 / (1 + GREATEST(0, (pr.period_start - p.today))::numeric / 365.0)))),3),
    'quality', CASE
        WHEN pp.total IS NULL THEN 'insufficient'
        WHEN pr.period_start > p.today + 365 THEN 'low'
        WHEN COALESCE(pp.wmape,1) < 0.2 THEN 'high'
        WHEN COALESCE(pp.wmape,1) < 0.4 THEN 'medium'
        ELSE 'low' END,
    'is_forecast', true,
    'sources', COALESCE(pp.sources, '[]'::jsonb)
  ) ORDER BY pr.i) j
  FROM periods pr CROSS JOIN params p LEFT JOIN per_period pp ON pp.i = pr.i
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
    'total', ROUND(SUM(outstanding_amount),2),
    'item_count', COUNT(*),
    'overdue', ROUND(COALESCE(SUM(outstanding_amount) FILTER (WHERE due_date IS NOT NULL AND due_date < (SELECT today FROM params)),0),2),
    'not_yet_due', ROUND(COALESCE(SUM(outstanding_amount) FILTER (WHERE due_date IS NULL OR due_date >= (SELECT today FROM params)),0),2),
    'categories', COALESCE((SELECT jsonb_agg(jsonb_build_object('category_key',ck,'category_label',cl,'outstanding',amt) ORDER BY amt DESC)
       FROM (SELECT category_key ck, MAX(category_label) cl, ROUND(SUM(outstanding_amount),2) amt
             FROM v_receivables_lines GROUP BY 1) c), '[]'::jsonb)
  ) j FROM v_receivables_lines
), streams_json AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'category_key', m.ck, 'category_label', COALESCE(lb.cl, m.ck),
    'product_key', m.pk, 'product_label', COALESCE(lb.pl, m.pk),
    'method', m.method, 'sample_days', m.sample_days, 'lookback_days', m.lookback_days,
    'median_daily', ROUND(m.level::numeric,2), 'trend_per_week', ROUND((m.slope_per_day * 7)::numeric, 2),
    'backtest_mape', m.mape, 'seasonality_applied', m.method = 'seasonal_level_trend',
    'insufficient_data', m.method = 'insufficient_data',
    'outstanding', COALESCE(o.outstanding, 0)
  ) ORDER BY m.level DESC), '[]'::jsonb) j
  FROM model m LEFT JOIN labels lb ON lb.ck=m.ck AND lb.pk=m.pk
  LEFT JOIN outs o ON o.ck=m.ck AND o.pk=m.pk
), no_hist AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'category_key', o.ck, 'product_key', o.pk,
    'product_label', COALESCE(lb.pl, o.pk), 'outstanding', o.outstanding,
    'reason', 'no collection history - scheduled due dates only') ORDER BY o.outstanding DESC), '[]'::jsonb) j
  FROM outs o LEFT JOIN labels lb ON lb.ck=o.ck AND lb.pk=o.pk
  WHERE NOT EXISTS (SELECT 1 FROM model m WHERE m.ck=o.ck AND m.pk=o.pk AND m.method <> 'insufficient_data')
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
  'meta', jsonb_build_object(
    'history_span_days', (SELECT (SELECT today FROM params) - MIN(d) FROM hist),
    'lookback_days', (SELECT lookback FROM params),
    'method_note', 'Per-stream robust level (28-day median) with weekly OLS trend, damped by backtest error and horizon distance; day-of-week seasonality when >=60 observed days. Streams with <8 observed days are excluded and reported separately.',
    'source', 'v_receivables_lines + observed collection history'
  )
)
  INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_receivables_predictive_forecast(text, integer, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_receivables_predictive_forecast(text, integer, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_receivables_predictive_forecast(text, integer, date) TO authenticated, service_role;