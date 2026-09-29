-- Read-only: platform expenses recorded in the past 7 Kampala days, and a
-- next-7-day prediction per category = its average daily expense over the past 28 days.
CREATE OR REPLACE FUNCTION public.get_cfo_seven_day_expenses()
RETURNS TABLE(day_offset integer, category text, amount numeric, item_count bigint, is_predicted boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
BEGIN
  PERFORM payables_guard();
  RETURN QUERY
  WITH e AS (
    SELECT (g.transaction_date AT TIME ZONE 'Africa/Kampala')::date AS d, g.category::text AS c, g.amount::numeric AS a
    FROM general_ledger g
    WHERE g.ledger_scope = 'platform' AND g.direction = 'cash_out'
      AND g.category::text LIKE '%\_expense'
      AND g.classification IS DISTINCT FROM 'admin_correction'
      AND g.transaction_date >= ((v_today - 28)::timestamp AT TIME ZONE 'Africa/Kampala')
      AND g.transaction_date <  ((v_today + 1)::timestamp AT TIME ZONE 'Africa/Kampala')
  ),
  past AS (
    SELECT (e.d - v_today)::int o, e.c, ROUND(SUM(e.a),2) s, COUNT(*) n
    FROM e WHERE e.d >= v_today - 7 AND e.d < v_today GROUP BY 1,2
  ),
  avg28 AS (
    SELECT e.c, ROUND(SUM(e.a)/28.0,2) s FROM e WHERE e.d >= v_today - 28 AND e.d < v_today GROUP BY 1
  )
  SELECT p.o, p.c, p.s, p.n, false FROM past p
  UNION ALL
  SELECT gs.i, a.c, a.s, 0::bigint, true FROM avg28 a CROSS JOIN generate_series(0,6) gs(i) WHERE a.s > 0;
END $$;
REVOKE ALL ON FUNCTION public.get_cfo_seven_day_expenses() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cfo_seven_day_expenses() TO authenticated;