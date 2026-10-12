CREATE OR REPLACE FUNCTION public.landlord_ops_principal_comparison(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_end date := LEAST(COALESCE(p_to, (now() AT TIME ZONE 'Africa/Kampala')::date), (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_start date;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public._has_enabled_role(auth.uid(), ARRAY['landlord_ops','cfo','ceo','coo','manager','financial_ops','super_admin','cto']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NOT NULL AND p_from > v_end THEN
    RAISE EXCEPTION 'Invalid comparison date range';
  END IF;
  -- Net deployed landlord float: returned/cancelled allocations are not principal at risk.
  -- Fully-paid here means paid to the landlord, NOT recovered from the tenant.
  WITH movements AS (
    SELECT (a.created_at AT TIME ZONE 'Africa/Kampala')::date AS day,
           COALESCE(a.allocated_amount,0) AS expected, 0::numeric AS recovered
    FROM public.agent_landlord_float_allocations a
    WHERE a.status IN ('open','partially_paid','fully_paid')
    UNION ALL
    SELECT (i.instalment_date AT TIME ZONE 'Africa/Kampala')::date,
           0::numeric, COALESCE(i.principal_component,0)
    FROM public.instalment_allocations i WHERE i.reversed_at IS NULL
  ), daily AS (
    SELECT day, SUM(expected) AS expected, SUM(recovered) AS recovered
    FROM movements WHERE day <= v_end GROUP BY day
  ), bounds AS (
    SELECT COALESCE(p_from, MIN(day), v_end) AS start_day FROM daily
  ), buckets AS (
    SELECT CASE WHEN v_end - b.start_day > 90 THEN date_trunc('month',d.day)::date ELSE d.day END AS day,
           SUM(d.expected) AS expected, SUM(d.recovered) AS recovered
    FROM daily d CROSS JOIN bounds b
    WHERE d.day >= b.start_day GROUP BY 1
    UNION ALL
    SELECT CASE WHEN v_end - b.start_day > 90 THEN date_trunc('month',s.day)::date ELSE s.day::date END,
           0::numeric, 0::numeric
    FROM bounds b CROSS JOIN LATERAL generate_series(b.start_day::timestamp, v_end::timestamp,
      CASE WHEN v_end - b.start_day > 90 THEN interval '1 month' ELSE interval '1 day' END) s(day)
  ), grouped AS (
    SELECT day, SUM(expected) AS expected, SUM(recovered) AS recovered FROM buckets GROUP BY day
  ), opening AS (
    SELECT COALESCE(SUM(d.expected),0) AS expected, COALESCE(SUM(d.recovered),0) AS recovered
    FROM daily d CROSS JOIN bounds b WHERE d.day < b.start_day
  ), trend AS (
    SELECT g.day, o.expected + SUM(g.expected) OVER (ORDER BY g.day) AS expected,
           o.recovered + SUM(g.recovered) OVER (ORDER BY g.day) AS recovered
    FROM grouped g CROSS JOIN opening o
  )
  SELECT jsonb_build_object(
    'as_of', v_end,
    'expected', COALESCE((SELECT SUM(expected) FROM daily),0),
    'recovered', COALESCE((SELECT SUM(recovered) FROM daily),0),
    'monthly', v_end - b.start_day > 90,
    'trend', COALESCE((SELECT jsonb_agg(jsonb_build_object('date',t.day,'expected',t.expected,'recovered',t.recovered) ORDER BY t.day) FROM trend t),'[]'::jsonb)
  ) INTO v_result FROM bounds b;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.landlord_ops_principal_comparison(date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landlord_ops_principal_comparison(date,date) TO authenticated, service_role;
COMMENT ON FUNCTION public.landlord_ops_principal_comparison(date,date) IS 'Read-only cumulative net disbursed landlord float versus non-reversed principal recovered, Kampala dates; same enabled-role gate as principal recovery rows. No ledger or wallet mutations.';