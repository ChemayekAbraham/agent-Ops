-- tops_shortfall_daily_trend: the collection shortfall for each of the last p_days Kampala
-- days, so managers can see whether it is improving. Read-only, additive: one new function,
-- nothing existing is altered.
--
-- Each day is computed exactly as tops_shortfall_lines computes a one-day window (its bill
-- and cash CTEs, with the day grouped instead of the window):
--   bill  = the pinned expected_ugx per plan for that Kampala day (agent_expected_day_plans)
--   cash  = non-reversed agent_collections (amount > 0, reversed_at IS NULL, rent_request_id
--           not null) made on that Kampala day, per plan
--   a plan is short when expected - LEAST(paid, expected) > 0
-- expected_ugx is the whole day's bill; collected_ugx is the per-plan capped collection
-- (LEAST(paid, expected)) over every billed plan; short_ugx = expected_ugx - collected_ugx,
-- which is the sum of short_ugx over the plans tops_shortfall_lines returns for that day and
-- ops_tenant_ops_home_range(...)->>'pending'. short_plans counts those plans. covered_pct is
-- collected / expected (1 dp, NULL when nothing was billed). Days with no bill (before
-- pinning began) are returned as zeros so a chart has no gaps. The last row is today and is
-- still moving; every earlier day is finished.
--
-- Every column reference is alias-qualified: the RETURNS TABLE output names are also
-- PL/pgSQL variables and an unqualified reference raises "column reference is ambiguous".

CREATE OR REPLACE FUNCTION public.tops_shortfall_daily_trend(p_days int DEFAULT 30)
RETURNS TABLE (
  day date,
  expected_ugx numeric,
  collected_ugx numeric,
  short_ugx numeric,
  short_plans int,
  covered_pct numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_first date;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN
    RAISE EXCEPTION 'invalid p_days: %, expected 1 to 90', p_days;
  END IF;

  v_first := v_today - (p_days - 1);

  RETURN QUERY
  WITH days AS (
    SELECT gs::date AS d FROM generate_series(v_first::timestamp, v_today::timestamp, interval '1 day') gs
  ),
  bill AS (
    SELECT dp.day AS d, dp.rent_request_id AS rr_id, SUM(dp.expected_ugx) AS expected_ugx
    FROM public.agent_expected_day_plans dp
    WHERE dp.day BETWEEN v_first AND v_today
    GROUP BY dp.day, dp.rent_request_id
  ),
  cash AS (
    SELECT (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS d, ac.rent_request_id AS rr_id, SUM(ac.amount) AS paid
    FROM public.agent_collections ac
    WHERE ac.created_at >= (v_first::timestamp AT TIME ZONE 'Africa/Kampala')
      AND ac.created_at < ((v_today + 1)::timestamp AT TIME ZONE 'Africa/Kampala')
      AND ac.amount > 0 AND ac.reversed_at IS NULL
      AND ac.rent_request_id IS NOT NULL
    GROUP BY 1, ac.rent_request_id
  ),
  per_plan AS (
    SELECT b.d, b.expected_ugx AS exp_ugx, LEAST(COALESCE(c.paid, 0), b.expected_ugx) AS capped
    FROM bill b
    LEFT JOIN cash c ON c.d = b.d AND c.rr_id = b.rr_id
  ),
  per_day AS (
    SELECT p.d,
           SUM(p.exp_ugx) AS exp_ugx,
           SUM(p.capped) AS capped,
           COUNT(*) FILTER (WHERE p.exp_ugx - p.capped > 0)::int AS short_plans
    FROM per_plan p
    GROUP BY p.d
  )
  SELECT
    dy.d,
    COALESCE(pd.exp_ugx, 0),
    COALESCE(pd.capped, 0),
    COALESCE(pd.exp_ugx, 0) - COALESCE(pd.capped, 0),
    COALESCE(pd.short_plans, 0),
    round(pd.capped / NULLIF(pd.exp_ugx, 0) * 100, 1)
  FROM days dy
  LEFT JOIN per_day pd ON pd.d = dy.d
  ORDER BY dy.d;
END;
$function$;

-- This schema's default privileges auto-grant new functions to anon; revoke explicitly.
REVOKE ALL ON FUNCTION public.tops_shortfall_daily_trend(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_shortfall_daily_trend(int) TO authenticated;
