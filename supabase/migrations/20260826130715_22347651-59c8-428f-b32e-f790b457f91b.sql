CREATE OR REPLACE FUNCTION public.get_receivables_forecast(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Nairobi')::date;
  v_from date := LEAST(p_from, p_to);
  v_to date := GREATEST(p_from, p_to);
  v_result jsonb;
BEGIN
  PERFORM receivables_guard();
  IF v_to > v_from + 400 THEN v_to := v_from + 400; END IF;

  WITH sched AS (
    SELECT GREATEST(l.due_date, v_from) AS d, l.category_key, l.category_label,
           l.product_key, l.product_label, 'scheduled'::text AS kind,
           l.outstanding_amount AS amount
    FROM v_receivables_lines l
    WHERE l.due_kind = 'scheduled' AND l.due_date IS NOT NULL
      AND l.due_date <= v_to
      AND (l.due_date >= v_from OR v_from <= v_today)
  ), proj AS (
    SELECT (v_today + g)::date AS d, p.category_key, p.category_label,
           p.product_key, p.product_label, 'projected'::text AS kind,
           CASE WHEN g = p.days - 1
                THEN p.outstanding_amount - p.daily_amount * (p.days - 1)
                ELSE p.daily_amount END AS amount
    FROM (
      SELECT l.*, LEAST(400, CEIL(l.outstanding_amount / l.daily_amount))::int AS days
      FROM v_receivables_lines l
      WHERE l.due_kind = 'projected' AND l.daily_amount > 0 AND l.outstanding_amount > 0
    ) p
    CROSS JOIN generate_series(0, 399) g
    WHERE g < p.days
      AND (v_today + g)::date BETWEEN v_from AND v_to
  ), rows AS (
    SELECT * FROM sched UNION ALL SELECT * FROM proj
  ), tot AS (
    SELECT COALESCE(ROUND(SUM(amount) FILTER (WHERE kind = 'scheduled'), 2), 0) AS sched_total,
           COALESCE(ROUND(SUM(amount) FILTER (WHERE kind = 'projected'), 2), 0) AS proj_total
    FROM rows
  ), unsched AS (
    SELECT COALESCE(ROUND(SUM(outstanding_amount), 2), 0) AS amt
    FROM v_receivables_lines
    WHERE (due_kind = 'projected' AND COALESCE(daily_amount, 0) <= 0)
       OR (due_kind = 'scheduled' AND due_date IS NULL)
  ), days AS (
    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'date')), '[]'::jsonb) AS j
    FROM (
      SELECT jsonb_build_object(
               'date', d,
               'scheduled', COALESCE(ROUND(SUM(amount) FILTER (WHERE kind = 'scheduled'), 2), 0),
               'projected', COALESCE(ROUND(SUM(amount) FILTER (WHERE kind = 'projected'), 2), 0),
               'total', ROUND(SUM(amount), 2)
             ) AS x
      FROM rows GROUP BY d
    ) s
  ), prods AS (
    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'total')::numeric DESC), '[]'::jsonb) AS j
    FROM (
      SELECT jsonb_build_object(
               'category_key', category_key, 'category_label', category_label,
               'product_key', product_key, 'product_label', product_label,
               'scheduled', COALESCE(ROUND(SUM(amount) FILTER (WHERE kind = 'scheduled'), 0), 0),
               'projected', COALESCE(ROUND(SUM(amount) FILTER (WHERE kind = 'projected'), 0), 0),
               'total', ROUND(SUM(amount), 2)
             ) AS x
      FROM rows
      GROUP BY category_key, category_label, product_key, product_label
    ) s
  ), basis AS (
    SELECT jsonb_build_object(
      'lookback_days', 90,
      'agent_collections', jsonb_build_object(
        'sample_days', (SELECT COUNT(DISTINCT (created_at AT TIME ZONE 'Africa/Nairobi')::date)
                          FROM agent_collections WHERE created_at >= now() - interval '90 days'),
        'median_daily', COALESCE((SELECT ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY amt))::numeric, 2) FROM (
                          SELECT SUM(COALESCE(amount, 0)) amt FROM agent_collections
                          WHERE created_at >= now() - interval '90 days'
                          GROUP BY (created_at AT TIME ZONE 'Africa/Nairobi')::date) q), 0)),
      'business_advance_repayments', jsonb_build_object(
        'sample_days', (SELECT COUNT(DISTINCT (created_at AT TIME ZONE 'Africa/Nairobi')::date)
                          FROM business_advance_repayments WHERE created_at >= now() - interval '90 days'),
        'median_daily', COALESCE((SELECT ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY amt))::numeric, 2) FROM (
                          SELECT SUM(COALESCE(amount, 0)) amt FROM business_advance_repayments
                          WHERE created_at >= now() - interval '90 days'
                          GROUP BY (created_at AT TIME ZONE 'Africa/Nairobi')::date) q), 0)),
      'credit_draw_ledger', jsonb_build_object(
        'sample_days', (SELECT COUNT(DISTINCT date) FROM credit_draw_ledger WHERE date >= v_today - 90),
        'median_daily', COALESCE((SELECT ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY amt))::numeric, 2) FROM (
                          SELECT SUM(COALESCE(amount_deducted, 0)) amt FROM credit_draw_ledger
                          WHERE date >= v_today - 90 GROUP BY date) q), 0))
    ) AS j
  )
  SELECT jsonb_build_object(
    'currency', 'UGX', 'today', v_today,
    'range', jsonb_build_object('from', v_from, 'to', v_to),
    'scheduled_total', tot.sched_total,
    'projected_total', tot.proj_total,
    'range_total', ROUND(tot.sched_total + tot.proj_total, 2),
    'unscheduled_outstanding', unsched.amt,
    'days', days.j,
    'products', prods.j,
    'projection_basis', basis.j,
    'source', 'v_receivables_lines'
  ) INTO v_result
  FROM tot, unsched, days, prods, basis;

  RETURN v_result;
END;
$function$;