CREATE OR REPLACE FUNCTION public.cto_cron_jobs_overview()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, cron
AS $$
DECLARE v jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND COALESCE(enabled, true)
      AND role = ANY (ARRAY['cto','super_admin']::public.app_role[])
  ) THEN RAISE EXCEPTION 'Not authorised'; END IF;

  WITH r AS (
    SELECT jobid, status, start_time, end_time, return_message, runid,
           EXTRACT(EPOCH FROM (end_time - start_time)) * 1000 AS ms
    FROM cron.job_run_details
    WHERE start_time > now() - interval '7 days'
  ), last AS (
    SELECT DISTINCT ON (jobid) jobid, status, start_time, end_time, ms, return_message
    FROM r ORDER BY jobid, runid DESC
  ), agg AS (
    SELECT jobid,
      count(*) FILTER (WHERE start_time > now() - interval '24 hours') runs_24h,
      count(*) FILTER (WHERE start_time > now() - interval '24 hours' AND status = 'failed') failed_24h,
      count(*) runs_7d,
      count(*) FILTER (WHERE status = 'failed') failed_7d,
      avg(ms) FILTER (WHERE status = 'succeeded') avg_ms,
      max(ms) max_ms,
      max(start_time) FILTER (WHERE status = 'failed') last_failed_at
    FROM r GROUP BY jobid
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'jobid', j.jobid, 'jobname', j.jobname, 'schedule', j.schedule, 'active', j.active,
    'database', j.database, 'username', j.username,
    'target_type', CASE WHEN j.command ILIKE '%net.http_post%' THEN 'edge_function' ELSE 'sql' END,
    'target', CASE WHEN j.command ILIKE '%net.http_post%'
                THEN COALESCE(substring(j.command from '/functions/v1/([A-Za-z0-9_\-]+)'), 'HTTP call')
                ELSE left(regexp_replace(j.command, '\s+', ' ', 'g'), 160) END,
    'command', left(j.command, 2000),
    'last_status', l.status, 'last_start', l.start_time, 'last_end', l.end_time,
    'last_duration_ms', round(l.ms), 'last_message', left(l.return_message, 500),
    'runs_24h', COALESCE(a.runs_24h,0), 'failed_24h', COALESCE(a.failed_24h,0),
    'runs_7d', COALESCE(a.runs_7d,0), 'failed_7d', COALESCE(a.failed_7d,0),
    'avg_duration_ms', round(a.avg_ms), 'max_duration_ms', round(a.max_ms),
    'last_failed_at', a.last_failed_at,
    'health', CASE
      WHEN NOT j.active THEN 'inactive'
      WHEN l.status = 'failed' THEN 'failing'
      WHEN l.jobid IS NULL THEN 'no_runs'
      WHEN COALESCE(a.failed_24h,0) > 0 THEN 'warning'
      ELSE 'healthy' END
  ) ORDER BY j.jobname), '[]'::jsonb) INTO v
  FROM cron.job j LEFT JOIN last l ON l.jobid = j.jobid LEFT JOIN agg a ON a.jobid = j.jobid;

  RETURN jsonb_build_object('jobs', v, 'as_at', now());
END $$;
REVOKE ALL ON FUNCTION public.cto_cron_jobs_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cto_cron_jobs_overview() TO authenticated;