-- Production monitoring for the empty-house map: viewport query latency,
-- clustering/render response time, cache reuse and viewport error rates,
-- bucketed by African region so slow regions are visible.
CREATE TABLE IF NOT EXISTS public.map_query_telemetry (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  region text NOT NULL,
  zoom smallint,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL DEFAULT now(),
  queries integer NOT NULL DEFAULT 0,
  cache_hits integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0,
  query_ms_sum numeric NOT NULL DEFAULT 0,
  query_ms_max numeric NOT NULL DEFAULT 0,
  renders integer NOT NULL DEFAULT 0,
  render_ms_sum numeric NOT NULL DEFAULT 0,
  render_ms_max numeric NOT NULL DEFAULT 0,
  houses_in_view_max integer NOT NULL DEFAULT 0,
  scan_capped_count integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_map_query_telemetry_created_region
  ON public.map_query_telemetry (created_at DESC, region);

GRANT SELECT ON public.map_query_telemetry TO authenticated;
GRANT ALL ON public.map_query_telemetry TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.map_query_telemetry_id_seq TO service_role;

ALTER TABLE public.map_query_telemetry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "map telemetry readable by engineering and leadership" ON public.map_query_telemetry;
CREATE POLICY "map telemetry readable by engineering and leadership"
  ON public.map_query_telemetry FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'operations')
  );

-- Clients post one aggregated row per region per flush window (never per event),
-- so volume stays flat as usage grows.
CREATE OR REPLACE FUNCTION public.record_map_query_telemetry(p_batch jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_rows integer := 0;
BEGIN
  IF v_user IS NULL THEN
    RETURN 0;
  END IF;
  IF p_batch IS NULL OR jsonb_typeof(p_batch) <> 'array' THEN
    RETURN 0;
  END IF;

  INSERT INTO public.map_query_telemetry (
    user_id, region, zoom, window_start, window_end, queries, cache_hits, failures,
    query_ms_sum, query_ms_max, renders, render_ms_sum, render_ms_max,
    houses_in_view_max, scan_capped_count, last_error
  )
  SELECT
    v_user,
    left(coalesce(nullif(trim(s->>'region'), ''), 'unknown'), 40),
    least(greatest(coalesce((s->>'zoom')::int, 0), 0), 22),
    coalesce((s->>'window_start')::timestamptz, now()),
    now(),
    least(greatest(coalesce((s->>'queries')::int, 0), 0), 100000),
    least(greatest(coalesce((s->>'cache_hits')::int, 0), 0), 100000),
    least(greatest(coalesce((s->>'failures')::int, 0), 0), 100000),
    least(greatest(coalesce((s->>'query_ms_sum')::numeric, 0), 0), 1e9),
    least(greatest(coalesce((s->>'query_ms_max')::numeric, 0), 0), 1e9),
    least(greatest(coalesce((s->>'renders')::int, 0), 0), 100000),
    least(greatest(coalesce((s->>'render_ms_sum')::numeric, 0), 0), 1e9),
    least(greatest(coalesce((s->>'render_ms_max')::numeric, 0), 0), 1e9),
    least(greatest(coalesce((s->>'houses_in_view_max')::int, 0), 0), 2000000000),
    least(greatest(coalesce((s->>'scan_capped_count')::int, 0), 0), 100000),
    left(nullif(trim(s->>'last_error'), ''), 300)
  FROM jsonb_array_elements(p_batch) AS s
  -- Ignore empty windows so idle sessions write nothing.
  WHERE coalesce((s->>'queries')::int, 0) + coalesce((s->>'cache_hits')::int, 0)
        + coalesce((s->>'failures')::int, 0) + coalesce((s->>'renders')::int, 0) > 0
  LIMIT 50;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Lean-database retention: prune opportunistically, never on every write.
  IF random() < 0.01 THEN
    DELETE FROM public.map_query_telemetry WHERE created_at < now() - interval '30 days';
  END IF;

  RETURN v_rows;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_map_query_telemetry(jsonb) TO authenticated;

-- Per-region rollup for the engineering dashboard.
CREATE OR REPLACE FUNCTION public.get_map_query_metrics(p_hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since timestamptz := now() - (least(greatest(coalesce(p_hours, 24), 1), 720) || ' hours')::interval;
  v_regions jsonb;
  v_overall jsonb;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'operations')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT coalesce(jsonb_agg(r ORDER BY (r->>'queries')::int DESC), '[]'::jsonb) INTO v_regions
  FROM (
    SELECT jsonb_build_object(
      'region', region,
      'queries', sum(queries)::int,
      'cache_hits', sum(cache_hits)::int,
      'failures', sum(failures)::int,
      'sessions', count(DISTINCT user_id)::int,
      'avg_query_ms', CASE WHEN sum(queries) > 0
        THEN round(sum(query_ms_sum) / sum(queries), 1) ELSE NULL END,
      'max_query_ms', round(max(query_ms_max), 1),
      'avg_render_ms', CASE WHEN sum(renders) > 0
        THEN round(sum(render_ms_sum) / sum(renders), 1) ELSE NULL END,
      'max_render_ms', round(max(render_ms_max), 1),
      'cache_reuse_rate', CASE WHEN sum(queries) + sum(cache_hits) > 0
        THEN round(sum(cache_hits)::numeric / (sum(queries) + sum(cache_hits)), 4) ELSE NULL END,
      'error_rate', CASE WHEN sum(queries) + sum(failures) > 0
        THEN round(sum(failures)::numeric / (sum(queries) + sum(failures)), 4) ELSE NULL END,
      'houses_in_view_max', max(houses_in_view_max)::int,
      'scan_capped', sum(scan_capped_count)::int,
      'last_error', (array_agg(last_error ORDER BY created_at DESC) FILTER (WHERE last_error IS NOT NULL))[1]
    ) AS r
    FROM public.map_query_telemetry
    WHERE created_at >= v_since
    GROUP BY region
  ) x;

  SELECT jsonb_build_object(
    'queries', coalesce(sum(queries), 0)::int,
    'cache_hits', coalesce(sum(cache_hits), 0)::int,
    'failures', coalesce(sum(failures), 0)::int,
    'sessions', count(DISTINCT user_id)::int,
    'avg_query_ms', CASE WHEN sum(queries) > 0 THEN round(sum(query_ms_sum) / sum(queries), 1) ELSE NULL END,
    'max_query_ms', round(coalesce(max(query_ms_max), 0), 1),
    'avg_render_ms', CASE WHEN sum(renders) > 0 THEN round(sum(render_ms_sum) / sum(renders), 1) ELSE NULL END,
    'max_render_ms', round(coalesce(max(render_ms_max), 0), 1),
    'cache_reuse_rate', CASE WHEN coalesce(sum(queries), 0) + coalesce(sum(cache_hits), 0) > 0
      THEN round(sum(cache_hits)::numeric / (sum(queries) + sum(cache_hits)), 4) ELSE NULL END,
    'error_rate', CASE WHEN coalesce(sum(queries), 0) + coalesce(sum(failures), 0) > 0
      THEN round(sum(failures)::numeric / (sum(queries) + sum(failures)), 4) ELSE NULL END
  ) INTO v_overall
  FROM public.map_query_telemetry
  WHERE created_at >= v_since;

  RETURN jsonb_build_object('since', v_since, 'hours', least(greatest(coalesce(p_hours, 24), 1), 720),
                            'overall', v_overall, 'regions', v_regions);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_map_query_metrics(integer) TO authenticated;