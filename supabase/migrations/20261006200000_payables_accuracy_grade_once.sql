-- Grade the payables back-test against one pre-aggregated pass of payment history
-- instead of re-scanning v_payables_payment_history per run/product (statement timeout).
-- Results are identical; read-only.
CREATE OR REPLACE FUNCTION public.get_payables_forecast_accuracy(p_origins integer DEFAULT 8, p_step_days integer DEFAULT 7, p_horizons integer[] DEFAULT ARRAY[1, 7, 30])
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

  WITH hist AS MATERIALIZED (
    SELECT h.d, h.category_key, h.product_key, SUM(h.amount) AS amount
    FROM v_payables_payment_history h
    WHERE h.amount > 0
    GROUP BY 1, 2, 3
  ), hist_day AS MATERIALIZED (
    SELECT d, SUM(amount) AS amount FROM hist GROUP BY d
  ), runs AS (
    SELECT (r->>'origin')::date origin, (r->>'horizon')::int horizon,
           (r->>'window_from')::date wf, (r->>'window_to')::date wt,
           (r->>'forecast')::numeric forecast, (r->>'low')::numeric low, (r->>'high')::numeric high,
           r->'products' products
    FROM jsonb_array_elements(v_runs) r
  ), graded AS (
    SELECT r.*,
      COALESCE((SELECT SUM(h.amount) FROM hist_day h
                WHERE h.d BETWEEN r.wf AND r.wt), 0) AS actual
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
      COALESCE((SELECT SUM(h.amount) FROM hist h
                WHERE h.category_key = pr.ck AND h.product_key = pr.pk
                  AND h.d BETWEEN pr.wf AND pr.wt), 0) AS actual
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
