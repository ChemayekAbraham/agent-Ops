CREATE OR REPLACE FUNCTION public.get_agent_collection_quality(p_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_days integer := GREATEST(1, LEAST(COALESCE(p_days, 14), 92));
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_result jsonb;
BEGIN
  IF NOT public.agent_ops_report_authorized() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  WITH calendar AS (
    SELECT generate_series(v_today - (v_days - 1), v_today, interval '1 day')::date AS day
  ), daily AS (
    SELECT
      l.day,
      COUNT(*) FILTER (
        WHERE l.expected_ugx > 0 AND l.settled_ugx >= l.expected_ugx
      )::integer AS full,
      COUNT(*) FILTER (
        WHERE l.expected_ugx > 0 AND l.settled_ugx > 0 AND l.settled_ugx < l.expected_ugx
      )::integer AS partial,
      COUNT(*) FILTER (
        WHERE l.expected_ugx > 0 AND l.settled_ugx = 0
      )::integer AS missed,
      COALESCE(SUM(
        CASE
          WHEN l.expected_ugx > 0 THEN GREATEST(l.expected_ugx - l.settled_ugx, 0)
          ELSE 0
        END
      ), 0)::numeric AS shortfall
    FROM public.v_rent_day_ledger l
    WHERE l.day BETWEEN v_today - (v_days - 1) AND v_today
    GROUP BY l.day
  ), series AS (
    SELECT
      c.day,
      COALESCE(d.full, 0) AS full,
      COALESCE(d.partial, 0) AS partial,
      COALESCE(d.missed, 0) AS missed,
      COALESCE(d.shortfall, 0) AS shortfall
    FROM calendar c
    LEFT JOIN daily d USING (day)
    ORDER BY c.day
  )
  SELECT jsonb_build_object(
    'series', COALESCE(jsonb_agg(jsonb_build_object(
      'day', s.day,
      'label', to_char(s.day, 'FMDD Mon'),
      'full', s.full,
      'partial', s.partial,
      'missed', s.missed,
      'shortfall', s.shortfall
    ) ORDER BY s.day), '[]'::jsonb),
    'full', COALESCE(SUM(s.full), 0),
    'partial', COALESCE(SUM(s.partial), 0),
    'missed', COALESCE(SUM(s.missed), 0),
    'shortfall', COALESCE(SUM(s.shortfall), 0),
    'days', v_days,
    'through_day', v_today
  )
  INTO v_result
  FROM series s;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.get_agent_collection_quality(integer) IS
  'Agent Operations collection quality from pinned daily Rent Plan bills and their FIFO daily settlements, grouped by Kampala calendar day.';

REVOKE ALL ON FUNCTION public.get_agent_collection_quality(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_agent_collection_quality(integer) TO authenticated, service_role;