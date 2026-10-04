-- 1. Rebuild the 2-arg overload from the intact 1-arg base (range-aware wrapper)
DO $do$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public' AND p.proname = 'get_agent_products_services_report' AND p.pronargs = 1;

  IF d IS NULL THEN RAISE EXCEPTION 'base function not found'; END IF;

  d := replace(d, '(p_date date DEFAULT NULL::date)', '(p_date date DEFAULT NULL::date, p_from date DEFAULT NULL::date)');
  d := replace(d, E'DECLARE\n  v_day date;', E'DECLARE\n  v_day date;\n  v_from date;\n  v_len int;');
  d := replace(d,
    E'  v_start := (v_day::timestamp AT TIME ZONE ''Africa/Kampala'');\n  v_end := ((v_day + 1)::timestamp AT TIME ZONE ''Africa/Kampala'');\n  v_prev_start := ((v_day - 1)::timestamp AT TIME ZONE ''Africa/Kampala'');',
    E'  v_from := LEAST(COALESCE(p_from, v_day), v_day);\n  v_len := (v_day - v_from) + 1;\n  v_start := (v_from::timestamp AT TIME ZONE ''Africa/Kampala'');\n  v_end := ((v_day + 1)::timestamp AT TIME ZONE ''Africa/Kampala'');\n  v_prev_start := ((v_from - v_len)::timestamp AT TIME ZONE ''Africa/Kampala'');');
  d := replace(d, 'FROM agent_advance_ledger l WHERE l.date = v_day', 'FROM agent_advance_ledger l WHERE l.date >= v_from AND l.date <= v_day');
  d := replace(d, 'WHERE l.advance_id = av.id AND l.date = v_day', 'WHERE l.advance_id = av.id AND l.date >= v_from AND l.date <= v_day');
  d := replace(d, 'count(*) FILTER (WHERE sale_date = v_day)', 'count(*) FILTER (WHERE sale_date >= v_from AND sale_date <= v_day)');
  d := replace(d, E'    ''day'', v_day,', E'    ''day'', v_day,\n    ''from_date'', v_from,\n    ''to_date'', v_day,\n    ''range_days'', v_len,');

  IF position('p_from date' in d) = 0 THEN RAISE EXCEPTION 'signature rewrite failed'; END IF;
  IF position('v_from := LEAST' in d) = 0 THEN RAISE EXCEPTION 'window rewrite failed'; END IF;
  IF position('''from_date'', v_from' in d) = 0 THEN RAISE EXCEPTION 'output rewrite failed'; END IF;

  EXECUTE d;
END
$do$;

REVOKE ALL ON FUNCTION public.get_agent_products_services_report(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_agent_products_services_report(date, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_agent_products_services_report(date, date) TO authenticated, service_role;

-- 2. Add cumulative expected collections (start date .. report date) to the range overload
DO $do$
DECLARE d text; n text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public' AND p.proname = 'get_agent_products_services_report' AND p.pronargs = 2;

  IF d IS NULL THEN RAISE EXCEPTION 'range function not found'; END IF;

  n := replace(d,
    'COALESCE(sum(lr.daily_repayment),0) AS daily_receivable,',
    'COALESCE(sum(lr.daily_repayment),0) AS daily_receivable,
           COALESCE(sum(lr.daily_repayment * GREATEST(0, (v_day - GREATEST(v_from, COALESCE((lr.funded_at AT TIME ZONE ''Africa/Kampala'')::date, v_from))) + 1)),0) AS expected_cumulative,');

  n := replace(n,
    E'      ''daily_receivable'', (SELECT COALESCE(sum(daily_repayment),0) FROM live_rents),',
    E'      ''daily_receivable'', (SELECT COALESCE(sum(daily_repayment),0) FROM live_rents),\n      ''expected_cumulative'', (SELECT COALESCE(sum(daily_repayment * GREATEST(0, (v_day - GREATEST(v_from, COALESCE((funded_at AT TIME ZONE ''Africa/Kampala'')::date, v_from))) + 1)),0) FROM live_rents),\n      ''expected_days'', v_len,');

  IF position('expected_cumulative' in n) = 0 OR n = d THEN
    RAISE EXCEPTION 'cumulative expected rewrite failed';
  END IF;

  EXECUTE n;
END
$do$;

REVOKE ALL ON FUNCTION public.get_agent_products_services_report(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_agent_products_services_report(date, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_agent_products_services_report(date, date) TO authenticated, service_role;