-- Fix nested aggregate in the day-of-week factor block of
-- get_payment_collections_projection (avg() inside jsonb_object_agg over a
-- GROUP BY query is illegal). Rest of the function is unchanged.
CREATE OR REPLACE FUNCTION public.get_payment_collections_projection(
  p_granularity text DEFAULT 'week',
  p_periods integer DEFAULT 12
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Nairobi')::date;
  v_gran text := lower(coalesce(nullif(p_granularity, ''), 'week'));
  v_periods int := greatest(1, least(coalesce(p_periods, 12), 24));
  v_per_days int;
  v_level numeric;
  v_trend_daily numeric;
  v_observed int;
  v_span int;
  v_history jsonb;
  v_periods_json jsonb := '[]'::jsonb;
  v_dow jsonb;
  v_start date;
  v_end date;
  v_sum numeric;
  v_dowf numeric;
  v_end_off int;
  v_quality text;
  v_conf numeric;
  v_width numeric;
  p int;
  t int;
BEGIN
  IF v_gran NOT IN ('day','week','month','quarter') THEN
    RAISE EXCEPTION 'Invalid granularity: % (expected day|week|month|quarter)', p_granularity USING ERRCODE = '22023';
  END IF;
  IF NOT public.ops_tps_report_authorized() THEN
    RAISE EXCEPTION 'Not authorized to view Tenant Products & Services reports' USING ERRCODE = '42501';
  END IF;

  v_per_days := CASE v_gran WHEN 'day' THEN 1 WHEN 'week' THEN 7 WHEN 'month' THEN 30 ELSE 91 END;

  -- Observed daily collections over the 365-day lookback (shared definition).
  WITH daily AS (
    SELECT d, sum(amount)::numeric AS amount
    FROM public.v_receivables_collection_history
    WHERE d >= v_today - 365 AND d <= v_today
    GROUP BY d
  )
  SELECT count(*) FILTER (WHERE amount > 0),
         greatest(COALESCE(max(d), v_today) - COALESCE(min(d), v_today), 1),
         COALESCE(jsonb_agg(jsonb_build_object('date', d, 'amount', amount) ORDER BY d), '[]'::jsonb)
    INTO v_observed, v_span, v_history
    FROM daily;

  -- Level: median of the last 28 calendar days (missing days count as zero).
  WITH days AS (
    SELECT generate_series(v_today - 27, v_today, interval '1 day')::date AS d
  ), daily AS (
    SELECT d, sum(amount)::numeric AS amount
    FROM public.v_receivables_collection_history
    WHERE d >= v_today - 27 AND d <= v_today
    GROUP BY d
  )
  SELECT COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE(dy.amount, 0))::numeric, 0)
    INTO v_level
    FROM days LEFT JOIN daily dy USING (d);

  -- Trend: OLS slope of weekly totals over the lookback, expressed per day forward.
  WITH daily AS (
    SELECT d, sum(amount)::numeric AS amount
    FROM public.v_receivables_collection_history
    WHERE d >= v_today - 365 AND d <= v_today
    GROUP BY d
  ), weeks AS (
    SELECT ((v_today - d) / 7) AS wk_ago, sum(amount)::numeric AS wtotal
    FROM daily GROUP BY 1
  )
  SELECT COALESCE(-regr_slope(wtotal, wk_ago)::numeric / 7.0, 0)
    INTO v_trend_daily
    FROM weeks;

  -- Day-of-week factors (isodow 1..7) when enough observed days exist.
  IF v_observed >= 60 THEN
    WITH daily AS (
      SELECT d, sum(amount)::numeric AS amount
      FROM public.v_receivables_collection_history
      WHERE d >= v_today - 365 AND d <= v_today
      GROUP BY d
    ), per_dow AS (
      SELECT extract(isodow FROM d)::int AS dow, avg(amount) AS dow_avg
      FROM daily GROUP BY 1
    ), overall AS (
      SELECT avg(amount) AS overall_avg FROM daily
    )
    SELECT jsonb_object_agg(pd.dow, greatest(0.2, least(3.0, pd.dow_avg / nullif(o.overall_avg, 0))))
      INTO v_dow
      FROM per_dow pd CROSS JOIN overall o;
  END IF;

  -- Project forward day by day, aggregating into periods.
  v_start := v_today + 1;
  FOR p IN 1..v_periods LOOP
    v_end := v_start + v_per_days - 1;
    v_sum := 0;
    FOR t IN (v_start - v_today)..(v_end - v_today) LOOP
      v_dowf := 1;
      IF v_dow IS NOT NULL THEN
        v_dowf := coalesce(nullif(v_dow ->> extract(isodow FROM (v_today + t))::int, '')::numeric, 1);
      END IF;
      -- trend increment damped by 1/(1 + t/90) so far-out days cannot run away
      v_sum := v_sum + greatest(0, (v_level + v_trend_daily * t / (1 + t / 90.0)) * v_dowf);
    END LOOP;

    v_end_off := v_end - v_today;
    IF v_observed < 21 THEN
      v_quality := 'low'; v_conf := 0.35;
    ELSIF v_end_off <= greatest(v_span, 1) * 0.25 THEN
      v_quality := 'high'; v_conf := 0.85;
    ELSIF v_end_off <= v_span THEN
      v_quality := 'medium'; v_conf := 0.6;
    ELSE
      v_quality := 'low'; v_conf := 0.35;
    END IF;

    v_width := least(0.8, 0.15 + 0.6 * v_end_off::numeric / greatest(v_span, 1));

    v_periods_json := v_periods_json || jsonb_build_object(
      'period_start', v_start,
      'period_end', v_end,
      'label', to_char(v_start, 'DD Mon') || ' – ' || to_char(v_end, 'DD Mon YYYY'),
      'forecast_amount', round(v_sum),
      'low', greatest(0, round(v_sum * (1 - v_width))),
      'high', round(v_sum * (1 + v_width)),
      'confidence', v_conf,
      'quality', v_quality
    );
    v_start := v_end + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'currency', 'UGX',
    'granularity', v_gran,
    'history', v_history,
    'periods', v_periods_json,
    'meta', jsonb_build_object(
      'as_at', v_today,
      'timezone', 'Africa/Nairobi',
      'history_span_days', v_span,
      'observed_days', v_observed,
      'level_daily', round(v_level),
      'trend_weekly', round(v_trend_daily * 7),
      'has_day_of_week_factors', v_dow IS NOT NULL,
      'method', 'History-based trend only: 28-day median daily level + OLS weekly trend (damped by 1/(1 + t/90))' ||
                CASE WHEN v_dow IS NOT NULL THEN ' + day-of-week factors' ELSE '' END ||
                '. No manual growth assumptions; read from v_receivables_collection_history.'
    )
  );
END;
$func$;