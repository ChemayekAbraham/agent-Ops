-- Fixes three measurement bugs identified in the 2026-08-11 board technology report.
--
-- 1. Sign-in success rate was computed from ALL rows in login_phase_events,
--    which is a general boot/gate diagnostic stream (app.boot, guard checks,
--    gate checks, etc.), not a table of discrete login attempts — and no row
--    in it ever carries status='success', so the KPI counted nearly every
--    real login as a failure. The client now writes a dedicated
--    'auth.signin.attempt' phase per user-facing login (see
--    src/hooks/useAuthForm.ts); this migration scopes the KPI to that phase.
--
-- 2. Transaction rollback rate read pg_stat_database.xact_rollback/xact_commit,
--    which are cumulative since the last server restart, not scoped to any
--    day — producing a meaningless "daily" percentage. This adds a daily
--    snapshot table and switches the report to a real day-over-day delta.
--
-- 3. Notification delivery counted anything not yet flipped to status='sent'
--    as a hard failure, including messages still 'pending' or 'rate_limited'
--    in the async send queue, and 'suppressed' (deliberately not sent).
--    Only 'failed'/'dlq' are real failures.

CREATE TABLE IF NOT EXISTS public.db_stat_snapshots (
  day date PRIMARY KEY,
  xact_commit bigint NOT NULL,
  xact_rollback bigint NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.db_stat_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.db_stat_snapshots FROM public;
REVOKE ALL ON public.db_stat_snapshots FROM anon;
REVOKE ALL ON public.db_stat_snapshots FROM authenticated;
GRANT ALL ON public.db_stat_snapshots TO service_role;
-- No policies: only the SECURITY DEFINER report function below touches this table.

-- NOTE: VOLATILE (was STABLE) because the function now records the daily
-- counter snapshot it diffs against. A STABLE function cannot INSERT.
CREATE OR REPLACE FUNCTION public.get_cto_daily_report(p_date date DEFAULT (now() AT TIME ZONE 'Africa/Kampala')::date)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
DECLARE
  v_start timestamptz := (p_date::text || ' 00:00:00+03')::timestamptz;
  v_end   timestamptz := (p_date::text || ' 23:59:59.999+03')::timestamptz;
  v_prev_start timestamptz := v_start - interval '1 day';
  v_7d timestamptz := v_end - interval '7 days';
  v_30d timestamptz := v_end - interval '30 days';
  v jsonb;
  v_slow jsonb := '[]'::jsonb;
  v_snap_commit bigint;
  v_snap_rollback bigint;
  v_prev_commit bigint;
  v_prev_rollback bigint;
  v_prev_at timestamptz;
  v_day_commits bigint;
  v_day_rollbacks bigint;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'manager')
    OR auth.role() = 'service_role' OR auth.uid() IS NULL
  ) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  BEGIN
    SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) INTO v_slow FROM (
      SELECT left(query, 110) AS query, round(mean_exec_time::numeric,1) AS mean_ms, calls
      FROM extensions.pg_stat_statements
      WHERE query NOT ILIKE '%pg_stat%' AND calls > 20
      ORDER BY mean_exec_time DESC LIMIT 6
    ) x;
  EXCEPTION WHEN OTHERS THEN
    v_slow := '[]'::jsonb;
  END;

  -- Daily commit/rollback delta: snapshot the current cumulative counters,
  -- diff against the most recent earlier snapshot. Falls back to 0 (rather
  -- than a negative number or the raw lifetime total) when there is no prior
  -- baseline yet or the counters reset under us (server restart).
  SELECT xact_commit, xact_rollback INTO v_snap_commit, v_snap_rollback
  FROM pg_stat_database WHERE datname = current_database();

  INSERT INTO public.db_stat_snapshots (day, xact_commit, xact_rollback, captured_at)
  VALUES (p_date, v_snap_commit, v_snap_rollback, now())
  ON CONFLICT (day) DO UPDATE
    SET xact_commit = EXCLUDED.xact_commit,
        xact_rollback = EXCLUDED.xact_rollback,
        captured_at = EXCLUDED.captured_at;

  SELECT xact_commit, xact_rollback, captured_at
    INTO v_prev_commit, v_prev_rollback, v_prev_at
  FROM public.db_stat_snapshots
  WHERE day < p_date
  ORDER BY day DESC LIMIT 1;

  IF v_prev_commit IS NULL OR v_snap_commit < v_prev_commit THEN
    v_day_commits := 0;
    v_day_rollbacks := 0;
  ELSE
    v_day_commits := v_snap_commit - v_prev_commit;
    v_day_rollbacks := v_snap_rollback - v_prev_rollback;
  END IF;

  SELECT jsonb_build_object(
    'date', p_date,
    'generated_at', now(),

    'platform', jsonb_build_object(
      'total_users', (SELECT count(*) FROM profiles),
      'new_users_today', (SELECT count(*) FROM profiles WHERE created_at BETWEEN v_start AND v_end),
      'active_24h', (SELECT count(*) FROM profiles WHERE last_active_at >= v_end - interval '24 hours'),
      'active_7d', (SELECT count(*) FROM profiles WHERE last_active_at >= v_7d),
      'active_30d', (SELECT count(*) FROM profiles WHERE last_active_at >= v_30d),
      'events_today', (SELECT count(*) FROM system_events WHERE created_at BETWEEN v_start AND v_end),
      'events_prev_day', (SELECT count(*) FROM system_events WHERE created_at BETWEEN v_prev_start AND v_start),
      'events_7d', (SELECT count(*) FROM system_events WHERE created_at >= v_7d AND created_at <= v_end),
      'txn_today', (SELECT count(*) FROM general_ledger WHERE created_at BETWEEN v_start AND v_end)
    ),

    'errors', jsonb_build_object(
      'today', (SELECT count(*) FROM client_error_reports WHERE created_at BETWEEN v_start AND v_end),
      'prev_day', (SELECT count(*) FROM client_error_reports WHERE created_at BETWEEN v_prev_start AND v_start),
      'last_7d', (SELECT count(*) FROM client_error_reports WHERE created_at >= v_7d AND created_at <= v_end),
      'affected_users_today', (SELECT count(DISTINCT user_id) FROM client_error_reports WHERE created_at BETWEEN v_start AND v_end),
      'top_routes', COALESCE((
        SELECT jsonb_agg(x) FROM (
          SELECT COALESCE(route,'unknown') AS route, count(*) AS n
          FROM client_error_reports WHERE created_at >= v_7d AND created_at <= v_end
          GROUP BY 1 ORDER BY n DESC LIMIT 6
        ) x), '[]'::jsonb),
      'top_messages', COALESCE((
        SELECT jsonb_agg(x) FROM (
          SELECT left(COALESCE(message,'unknown'),120) AS message, count(*) AS n
          FROM client_error_reports WHERE created_at >= v_7d AND created_at <= v_end
          GROUP BY 1 ORDER BY n DESC LIMIT 6
        ) x), '[]'::jsonb),
      'daily_trend', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('d', t.d, 'n', t.n) ORDER BY t.d) FROM (
          SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date AS d, count(*) AS n
          FROM client_error_reports WHERE created_at >= v_end - interval '14 days' AND created_at <= v_end
          GROUP BY 1
        ) t), '[]'::jsonb),
      'compat_events_7d', (SELECT count(*) FROM browser_compat_events WHERE created_at >= v_7d AND created_at <= v_end)
    ),

    -- FIX 1: scoped to the dedicated per-login phase written by the client.
    'auth', jsonb_build_object(
      'login_events_today', (SELECT count(*) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND phase = 'auth.signin.attempt'),
      'login_success_today', (SELECT count(*) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND phase = 'auth.signin.attempt' AND status = 'success'),
      'login_failures_today', (SELECT count(*) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND phase = 'auth.signin.attempt' AND status <> 'success'),
      'login_failures_7d', (SELECT count(*) FROM login_phase_events WHERE created_at >= v_7d AND created_at <= v_end AND phase = 'auth.signin.attempt' AND status <> 'success'),
      'login_events_7d', (SELECT count(*) FROM login_phase_events WHERE created_at >= v_7d AND created_at <= v_end AND phase = 'auth.signin.attempt'),
      'login_rate_limited_today', (SELECT count(*) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND phase = 'auth.signin.attempt' AND status = 'rate_limited'),
      'avg_login_ms_today', (SELECT round(avg((detail->>'totalMs')::numeric)) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND phase = 'auth.signin.attempt' AND (detail->>'totalMs') ~ '^[0-9]+$'),
      'avg_phase_ms_today', (SELECT round(avg(duration_ms)) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND duration_ms IS NOT NULL),
      'otp_attempts_today', (SELECT count(*) FROM otp_login_audit WHERE created_at BETWEEN v_start AND v_end),
      'otp_failures_today', (SELECT count(*) FROM otp_login_audit WHERE created_at BETWEEN v_start AND v_end AND outcome <> 'success')
    ),

    'security', jsonb_build_object(
      'signup_attempts_today', (SELECT count(*) FROM signup_attempts WHERE created_at BETWEEN v_start AND v_end),
      'signup_blocked_today', (SELECT count(*) FROM signup_attempts WHERE created_at BETWEEN v_start AND v_end AND status <> 'success'),
      'blocked_ips_total', (SELECT count(*) FROM blocked_signup_ips),
      'fraud_blocks_active', (SELECT count(*) FROM fraud_identity_blocks WHERE status = 'active'),
      'fraud_blocks_today', (SELECT count(*) FROM fraud_identity_blocks WHERE created_at BETWEEN v_start AND v_end),
      'privileged_accounts', (SELECT count(DISTINCT user_id) FROM user_roles WHERE role IN ('super_admin','manager','cto','ceo','cfo','coo','access_admin')),
      'audit_writes_today', (SELECT count(*) FROM audit_logs WHERE created_at BETWEEN v_start AND v_end),
      'rls_tables', (SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relrowsecurity),
      'public_tables', (SELECT count(*) FROM pg_tables WHERE schemaname='public')
    ),

    -- FIX 2: rollbacks/commits are now a real day-over-day delta.
    'infra', jsonb_build_object(
      'db_size_bytes', pg_database_size(current_database()),
      'connections', (SELECT count(*) FROM pg_stat_activity),
      'max_connections', (SELECT setting::int FROM pg_settings WHERE name='max_connections'),
      'deadlocks', (SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()),
      'rollbacks', v_day_rollbacks,
      'commits', v_day_commits,
      'rollback_baseline_at', v_prev_at,
      'rollbacks_cumulative_lifetime', v_snap_rollback,
      'commits_cumulative_lifetime', v_snap_commit,
      'cache_hit_pct', (SELECT round(100.0 * blks_hit / NULLIF(blks_hit + blks_read,0), 2) FROM pg_stat_database WHERE datname = current_database()),
      'uptime_hours', (SELECT round((EXTRACT(epoch FROM (now() - pg_postmaster_start_time()))/3600.0)::numeric, 1)),
      'largest_tables', COALESCE((
        SELECT jsonb_agg(x) FROM (
          SELECT relname AS table_name, pg_total_relation_size(c.oid) AS bytes
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind='r'
          ORDER BY 2 DESC LIMIT 8
        ) x), '[]'::jsonb)
    ),

    'backups', jsonb_build_object(
      'runs_7d', (SELECT count(*) FROM backup_runs WHERE created_at >= v_7d),
      'failures_7d', (SELECT count(*) FROM backup_runs WHERE created_at >= v_7d AND status <> 'success'),
      'latest', (SELECT to_jsonb(b) FROM (SELECT status, created_at, size_bytes, table_count, row_count FROM backup_runs ORDER BY created_at DESC LIMIT 1) b)
    ),

    'jobs', jsonb_build_object(
      'total_scheduled', (SELECT count(*) FROM cron.job),
      'runs_24h', (SELECT count(*) FROM cron.job_run_details WHERE start_time >= v_end - interval '24 hours'),
      'failed_24h', (SELECT count(*) FROM cron.job_run_details WHERE start_time >= v_end - interval '24 hours' AND status <> 'succeeded'),
      'failing', COALESCE((
        SELECT jsonb_agg(x) FROM (
          SELECT j.jobname, count(*) AS n, max(left(COALESCE(d.return_message,''),140)) AS last_error
          FROM cron.job_run_details d JOIN cron.job j USING (jobid)
          WHERE d.start_time >= v_end - interval '24 hours' AND d.status <> 'succeeded'
          GROUP BY 1 ORDER BY n DESC LIMIT 8
        ) x), '[]'::jsonb)
    ),

    -- FIX 3: only 'failed'/'dlq' are real delivery failures; queued and
    -- deliberately suppressed messages are reported separately.
    'email', jsonb_build_object(
      'sent_today', (SELECT count(*) FROM email_send_log WHERE created_at BETWEEN v_start AND v_end),
      'delivered_today', (SELECT count(*) FROM email_send_log WHERE created_at BETWEEN v_start AND v_end AND status = 'sent'),
      'failed_today', (SELECT count(*) FROM email_send_log WHERE created_at BETWEEN v_start AND v_end AND status IN ('failed','dlq')),
      'pending_today', (SELECT count(*) FROM email_send_log WHERE created_at BETWEEN v_start AND v_end AND status IN ('pending','rate_limited')),
      'suppressed_today', (SELECT count(*) FROM email_send_log WHERE created_at BETWEEN v_start AND v_end AND status = 'suppressed'),
      'failed_7d', (SELECT count(*) FROM email_send_log WHERE created_at >= v_7d AND created_at <= v_end AND status IN ('failed','dlq')),
      'sent_7d', (SELECT count(*) FROM email_send_log WHERE created_at >= v_7d AND created_at <= v_end)
    ),

    'slow_queries', v_slow
  ) INTO v;

  RETURN v;
END;
$function$;