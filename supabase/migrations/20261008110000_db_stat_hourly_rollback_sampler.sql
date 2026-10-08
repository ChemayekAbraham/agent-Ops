-- Hourly rollback sampler.
-- db_stat_snapshots is daily, so a rollback spike (09-24..26, 09-30, 10-05..07:
-- 17-37% vs ~2.4% on quiet days) cannot be localised to an hour or a workload,
-- and pg_stat_statements never records statements that ERROR (which is what an
-- implicit rollback is). This keeps an hourly xact_commit/xact_rollback delta
-- plus the statements whose call count surged in that hour, so the next spike
-- can be correlated with what was running. Read-only instrumentation: no
-- application behaviour changes.

CREATE TABLE IF NOT EXISTS public.db_stat_hourly (
  captured_at timestamptz PRIMARY KEY,
  xact_commit bigint NOT NULL,
  xact_rollback bigint NOT NULL,
  delta_commit bigint,
  delta_rollback bigint,
  rollback_pct numeric,
  backends int,
  top_statements jsonb          -- top call-count surges since the previous sample
);
ALTER TABLE public.db_stat_hourly ENABLE ROW LEVEL SECURITY;  -- service role only

CREATE TABLE IF NOT EXISTS public.db_stmt_last_sample (
  queryid bigint NOT NULL,
  userid oid NOT NULL,
  calls bigint NOT NULL,
  query text,
  PRIMARY KEY (queryid, userid)
);
ALTER TABLE public.db_stmt_last_sample ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.capture_db_stat_hourly()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_now timestamptz := date_trunc('minute', now());
  v_c bigint; v_r bigint;
  v_prev public.db_stat_hourly%ROWTYPE;
  v_dc bigint; v_dr bigint; v_pct numeric; v_top jsonb;
BEGIN
  SELECT xact_commit, xact_rollback INTO v_c, v_r
  FROM pg_stat_database WHERE datname = current_database();

  SELECT * INTO v_prev FROM public.db_stat_hourly ORDER BY captured_at DESC LIMIT 1;

  -- Counters going backwards means a restart/stats reset: no trustworthy delta.
  IF v_prev.captured_at IS NOT NULL AND v_c >= v_prev.xact_commit AND v_r >= v_prev.xact_rollback THEN
    v_dc := v_c - v_prev.xact_commit;
    v_dr := v_r - v_prev.xact_rollback;
    v_pct := round(100.0 * v_dr / NULLIF(v_dc + v_dr, 0), 1);

    SELECT COALESCE(jsonb_agg(x ORDER BY x.surge DESC), '[]'::jsonb) INTO v_top
    FROM (
      SELECT left(regexp_replace(s.query, '\s+', ' ', 'g'), 160) AS query,
             s.calls - COALESCE(l.calls, 0) AS surge
      FROM extensions.pg_stat_statements s
      LEFT JOIN public.db_stmt_last_sample l USING (queryid, userid)
      WHERE s.calls > COALESCE(l.calls, 0)
        AND s.query NOT ILIKE '%pg_stat_statements%'
      ORDER BY s.calls - COALESCE(l.calls, 0) DESC
      LIMIT 15
    ) x;
  END IF;

  TRUNCATE public.db_stmt_last_sample;
  INSERT INTO public.db_stmt_last_sample (queryid, userid, calls, query)
  SELECT queryid, userid, calls, left(query, 160)
  FROM extensions.pg_stat_statements
  WHERE queryid IS NOT NULL
  ON CONFLICT DO NOTHING;

  INSERT INTO public.db_stat_hourly
    (captured_at, xact_commit, xact_rollback, delta_commit, delta_rollback, rollback_pct, backends, top_statements)
  VALUES (v_now, v_c, v_r, v_dc, v_dr, v_pct,
          (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()), v_top)
  ON CONFLICT (captured_at) DO NOTHING;

  DELETE FROM public.db_stat_hourly WHERE captured_at < now() - interval '30 days';

  RETURN jsonb_build_object('captured_at', v_now, 'delta_commit', v_dc, 'delta_rollback', v_dr, 'rollback_pct', v_pct);
END;
$$;
REVOKE ALL ON FUNCTION public.capture_db_stat_hourly() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_db_stat_hourly() TO service_role;

DO $$
DECLARE v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'capture-db-stat-hourly';
  IF v_jobid IS NOT NULL THEN PERFORM cron.unschedule(v_jobid); END IF;
END $$;

SELECT cron.schedule('capture-db-stat-hourly', '2 * * * *', $$SELECT public.capture_db_stat_hourly();$$);
