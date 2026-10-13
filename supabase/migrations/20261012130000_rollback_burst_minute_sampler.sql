-- Rollback burst catcher (doc 218).
-- db_stat_hourly shows the 22% rollback rate is NOT a steady fault: daytime runs
-- ~1%, but one hour a night produces 260k-386k rollbacks (~85/s) with normal
-- commit volume. pg_stat_statements never records statements that ERROR, so the
-- source cannot be read after the fact. This samples every minute and, only when
-- a minute's rollback delta is abnormal, stores who was connected and running.
-- Read-only instrumentation: no application behaviour changes.

CREATE TABLE IF NOT EXISTS public.db_rollback_minute (
  captured_at timestamptz PRIMARY KEY,
  xact_commit bigint NOT NULL,
  xact_rollback bigint NOT NULL,
  delta_commit bigint,
  delta_rollback bigint
);
ALTER TABLE public.db_rollback_minute ENABLE ROW LEVEL SECURITY;  -- service role only

CREATE TABLE IF NOT EXISTS public.db_rollback_burst_evidence (
  captured_at timestamptz PRIMARY KEY,
  delta_rollback bigint NOT NULL,
  by_backend jsonb,        -- non-idle + idle-in-transaction backends grouped by role/app
  running_queries jsonb,   -- up to 25 non-idle statements (truncated)
  running_cron jsonb       -- cron jobs with status 'running'
);
ALTER TABLE public.db_rollback_burst_evidence ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.capture_rollback_minute()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_now timestamptz := date_trunc('minute', now());
  v_c bigint; v_r bigint;
  v_prev public.db_rollback_minute%ROWTYPE;
  v_dc bigint; v_dr bigint;
BEGIN
  SELECT xact_commit, xact_rollback INTO v_c, v_r
  FROM pg_stat_database WHERE datname = current_database();

  SELECT * INTO v_prev FROM public.db_rollback_minute ORDER BY captured_at DESC LIMIT 1;

  IF v_prev.captured_at IS NOT NULL AND v_c >= v_prev.xact_commit AND v_r >= v_prev.xact_rollback THEN
    v_dc := v_c - v_prev.xact_commit;
    v_dr := v_r - v_prev.xact_rollback;
  END IF;

  INSERT INTO public.db_rollback_minute (captured_at, xact_commit, xact_rollback, delta_commit, delta_rollback)
  VALUES (v_now, v_c, v_r, v_dc, v_dr)
  ON CONFLICT (captured_at) DO NOTHING;

  -- Baseline is ~10-20 rollbacks/min; the nightly burst is ~5,000/min.
  IF COALESCE(v_dr, 0) >= 1500 THEN
    INSERT INTO public.db_rollback_burst_evidence (captured_at, delta_rollback, by_backend, running_queries, running_cron)
    VALUES (
      v_now, v_dr,
      (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
         SELECT usename, application_name, state, count(*) AS n
         FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND state IS DISTINCT FROM 'idle'
         GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 20) x),
      (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
         SELECT usename, application_name, state, wait_event_type, wait_event,
                now() - xact_start AS xact_age,
                left(regexp_replace(query, '\s+', ' ', 'g'), 200) AS query
         FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND state IS DISTINCT FROM 'idle'
         ORDER BY xact_start NULLS LAST LIMIT 25) x),
      (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
         SELECT j.jobname, d.start_time
         FROM cron.job_run_details d JOIN cron.job j USING (jobid)
         WHERE d.status = 'running' AND d.start_time > now() - interval '2 hours') x)
    )
    ON CONFLICT (captured_at) DO NOTHING;
  END IF;

  DELETE FROM public.db_rollback_minute WHERE captured_at < now() - interval '3 days';
  DELETE FROM public.db_rollback_burst_evidence WHERE captured_at < now() - interval '30 days';

  RETURN jsonb_build_object('captured_at', v_now, 'delta_commit', v_dc, 'delta_rollback', v_dr);
END;
$$;
REVOKE ALL ON FUNCTION public.capture_rollback_minute() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_rollback_minute() TO service_role;

DO $$
DECLARE v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'capture-rollback-minute';
  IF v_jobid IS NOT NULL THEN PERFORM cron.unschedule(v_jobid); END IF;
END $$;

SELECT cron.schedule('capture-rollback-minute', '* * * * *', $$SELECT public.capture_rollback_minute();$$);
