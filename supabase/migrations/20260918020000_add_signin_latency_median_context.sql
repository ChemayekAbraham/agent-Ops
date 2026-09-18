-- get_cto_daily_report's only sign-in latency figure was a raw mean of
-- login_phase_events.detail->>'totalMs' for phase='auth.signin.attempt'.
-- Verified live against 2026-09-17 data: mean = 67,113 ms (the number the
-- 2026-09-17 report flagged as a same-day P1, "sign-in effectively broken",
-- a 27x jump vs the prior day) while the median was 1,634.5 ms -- completely
-- normal. Of 340 attempts that day, only 48 (14%) exceeded 60s, and 42 of
-- those 48 landed inside a single 2-minute window (10:33-10:34 UTC)
-- affecting 12 distinct users -- a short-lived clustered incident, not a
-- sustained platform degradation. A pure mean can't distinguish those two
-- very different situations and has already misdirected one day's triage
-- priority order (see docs/HANDOVER/20 and /29 for the same "mean of a
-- lifetime-cumulative or outlier-prone signal reads as a false same-day P1"
-- pattern recurring in this report before).
--
-- Add median/p95 and an outlier-attempt count alongside the existing mean
-- (kept, not removed, for any existing consumer) so a future report -- or a
-- human reading this JSON -- can tell "typical experience degraded" apart
-- from "a few sessions had a very bad two minutes" without re-deriving it
-- from raw login_phase_events each time.
CREATE OR REPLACE FUNCTION public.get_cto_daily_report(p_date date DEFAULT ((now() AT TIME ZONE 'Africa/Kampala'::text))::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_start timestamptz := (p_date::text || ' 00:00:00+03')::timestamptz;
  v_end   timestamptz := (p_date::text || ' 23:59:59.999+03')::timestamptz;
  v_prev_start timestamptz := v_start - interval '1 day';
  v_7d timestamptz := v_end - interval '7 days';
  v_30d timestamptz := v_end - interval '30 days';
  v jsonb;
  v_slow jsonb := '[]'::jsonb;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_snap_commit bigint;
  v_snap_rollback bigint;
  v_snap_deadlocks bigint;
  v_prev_commit bigint;
  v_prev_rollback bigint;
  v_prev_deadlocks bigint;
  v_prev_at timestamptz;
  v_prev_day date;
  v_day_commits bigint;
  v_day_rollbacks bigint;
  v_day_deadlocks bigint;
  v_infra_trustworthy boolean;
  v_roles jsonb := '{}'::jsonb;
  v_sms jsonb := '{}'::jsonb;
  v_otp jsonb := '{}'::jsonb;
  v_signin jsonb := '{}'::jsonb;
  v_email jsonb := '{}'::jsonb;
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

  IF p_date = v_today THEN
    SELECT xact_commit, xact_rollback, deadlocks INTO v_snap_commit, v_snap_rollback, v_snap_deadlocks
    FROM pg_stat_database WHERE datname = current_database();

    INSERT INTO public.db_stat_snapshots (day, xact_commit, xact_rollback, deadlocks, captured_at)
    VALUES (p_date, v_snap_commit, v_snap_rollback, v_snap_deadlocks, now())
    ON CONFLICT (day) DO UPDATE
      SET xact_commit = EXCLUDED.xact_commit,
          xact_rollback = EXCLUDED.xact_rollback,
          deadlocks = EXCLUDED.deadlocks,
          captured_at = EXCLUDED.captured_at;
  ELSE
    SELECT xact_commit, xact_rollback, deadlocks INTO v_snap_commit, v_snap_rollback, v_snap_deadlocks
    FROM public.db_stat_snapshots WHERE day = p_date;
  END IF;

  SELECT xact_commit, xact_rollback, deadlocks, captured_at, day
    INTO v_prev_commit, v_prev_rollback, v_prev_deadlocks, v_prev_at, v_prev_day
  FROM public.db_stat_snapshots
  WHERE day < p_date
  ORDER BY day DESC LIMIT 1;

  v_infra_trustworthy := (
    v_snap_commit IS NOT NULL AND v_prev_commit IS NOT NULL
    AND v_prev_day = (p_date - 1)
    AND v_snap_commit >= v_prev_commit
    AND v_snap_rollback >= v_prev_rollback
  );

  IF v_infra_trustworthy THEN
    v_day_commits := v_snap_commit - v_prev_commit;
    v_day_rollbacks := v_snap_rollback - v_prev_rollback;
    v_day_deadlocks := GREATEST(COALESCE(v_snap_deadlocks,0) - COALESCE(v_prev_deadlocks,0), 0);
  ELSE
    v_day_commits := NULL;
    v_day_rollbacks := NULL;
    v_day_deadlocks := NULL;
  END IF;

  WITH agent_rr AS (
    SELECT DISTINCT agent_id FROM public.rent_requests
    WHERE agent_id IS NOT NULL
      AND status IN ('funded','repaying','completed','coo_approved','agent_ops_approved','tenant_ops_approved')
  ), agent_hl AS (
    SELECT DISTINCT agent_id FROM public.house_listings
    WHERE agent_id IS NOT NULL AND verified IS TRUE
  ), agent_col AS (
    SELECT DISTINCT agent_id FROM public.agent_collections WHERE agent_id IS NOT NULL
  ), agents AS (
    SELECT agent_id FROM agent_rr
    UNION SELECT agent_id FROM agent_hl
    UNION SELECT agent_id FROM agent_col
  )
  SELECT jsonb_build_object(
    'agents_active', (SELECT count(*) FROM agents),
    'agents_verified_listing', (SELECT count(*) FROM agent_hl),
    'agents_approved_rent_request', (SELECT count(*) FROM agent_rr),
    'agents_collecting_rent', (SELECT count(*) FROM agent_col),
    'agents_fully_productive', (
      SELECT count(*) FROM agent_hl h
      WHERE EXISTS (SELECT 1 FROM agent_rr r WHERE r.agent_id = h.agent_id)
        AND EXISTS (SELECT 1 FROM agent_col c WHERE c.agent_id = h.agent_id)
    ),
    'tenants_active', (
      SELECT count(DISTINCT tenant_id) FROM public.rent_requests
      WHERE tenant_id IS NOT NULL AND status IN ('funded','repaying','completed')
    ),
    'tenants_intake_queue', (
      SELECT count(DISTINCT tenant_id) FROM public.rent_requests
      WHERE tenant_id IS NOT NULL AND status = 'service_center_review'
    ),
    'funders_with_portfolio', (
      SELECT count(DISTINCT investor_id) FROM public.investor_portfolios WHERE investor_id IS NOT NULL
    ),
    'funders_agreement_accepted', (
      SELECT count(DISTINCT supporter_id) FROM public.supporter_agreement_acceptance WHERE supporter_id IS NOT NULL
    ),
    'landlords_engaged', (
      SELECT count(*) FROM (
        SELECT landlord_id FROM public.house_listings WHERE landlord_id IS NOT NULL
        UNION
        SELECT landlord_id FROM public.rent_requests WHERE landlord_id IS NOT NULL
      ) l
    ),
    'landlords_on_file', (SELECT count(*) FROM public.landlords),
    'landlords_are_users', false,
    'landlords_precision', 'approximate'
  ) INTO v_roles;

  WITH sms_dedup AS (
    SELECT *
    FROM public.sms_delivery_log
    WHERE created_at >= v_30d AND created_at <= v_end
      AND NOT (
        provider_response ? 'total_attempts'
        AND (provider_response->>'attempt_sequence')::int < (provider_response->>'total_attempts')::int
      )
  )
  SELECT jsonb_build_object(
    'total_30d', count(*),
    'sent', count(*) FILTER (WHERE status = 'sent'),
    'accepted', count(*) FILTER (WHERE status = 'accepted'),
    'delivered_confirmed', count(*) FILTER (WHERE status = 'delivered'),
    'pending', count(*) FILTER (WHERE status = 'pending'),
    'queued', count(*) FILTER (WHERE status = 'queued'),
    'failed', count(*) FILTER (WHERE status = 'failed'),
    'provider_accepted_rate', round(100.0 * count(*) FILTER (WHERE status IN ('sent','accepted','delivered')) / NULLIF(count(*),0), 1),
    'confirmed_rate', round(100.0 * count(*) FILTER (WHERE status = 'delivered') / NULLIF(count(*),0), 1),
    'failure_rate', round(100.0 * count(*) FILTER (WHERE status = 'failed') / NULLIF(count(*),0), 1),
    'unresolved_rate', round(100.0 * count(*) FILTER (WHERE status IN ('pending','queued')) / NULLIF(count(*),0), 1),
    'dlr_capable', count(*) FILTER (WHERE lower(COALESCE(provider,'')) LIKE '%yoola%'),
    'dlr_capable_rate', round(100.0 * count(*) FILTER (WHERE lower(COALESCE(provider,'')) LIKE '%yoola%') / NULLIF(count(*),0), 1)
  ) INTO v_sms
  FROM sms_dedup;

  WITH sms_otp_dedup AS (
    SELECT *
    FROM public.sms_delivery_log
    WHERE source = 'sms-otp' AND created_at >= v_30d AND created_at <= v_end
      AND NOT (
        provider_response ? 'total_attempts'
        AND (provider_response->>'attempt_sequence')::int < (provider_response->>'total_attempts')::int
      )
  )
  SELECT jsonb_build_object(
    'sends_30d', (SELECT count(*) FROM sms_otp_dedup),
    'sends_accepted_30d', (SELECT count(*) FROM sms_otp_dedup WHERE status IN ('sent','accepted','delivered')),
    'sends_failed_30d', (SELECT count(*) FROM sms_otp_dedup WHERE status = 'failed'),
    'verify_total_30d', (SELECT count(*) FROM public.otp_login_audit WHERE created_at >= v_30d AND created_at <= v_end),
    'verify_success_30d', (SELECT count(*) FROM public.otp_login_audit WHERE outcome = 'success' AND created_at >= v_30d AND created_at <= v_end),
    'verify_failed_30d', (SELECT count(*) FROM public.otp_login_audit WHERE outcome = 'failed' AND created_at >= v_30d AND created_at <= v_end),
    'verify_no_account_30d', (SELECT count(*) FROM public.otp_login_audit WHERE outcome = 'no_account' AND created_at >= v_30d AND created_at <= v_end),
    'verify_error_30d', (SELECT count(*) FROM public.otp_login_audit WHERE outcome = 'error' AND created_at >= v_30d AND created_at <= v_end)
  ) INTO v_otp;

  v_otp := v_otp || jsonb_build_object(
    'send_accepted_rate', round(100.0 * (v_otp->>'sends_accepted_30d')::numeric / NULLIF((v_otp->>'sends_30d')::numeric,0), 1),
    'verify_success_rate', round(100.0 * (v_otp->>'verify_success_30d')::numeric / NULLIF((v_otp->>'verify_total_30d')::numeric,0), 1)
  );

  WITH latest_email AS (
    SELECT DISTINCT ON (message_id) message_id, status, created_at
    FROM public.email_send_log
    WHERE created_at >= v_30d AND created_at <= v_end
    ORDER BY message_id, created_at DESC
  )
  SELECT jsonb_build_object(
    'total_30d', count(*),
    'delivered_30d', count(*) FILTER (WHERE status = 'sent'),
    'pending_30d', count(*) FILTER (WHERE status IN ('pending','rate_limited')),
    'suppressed_30d', count(*) FILTER (WHERE status = 'suppressed'),
    'failed_30d', count(*) FILTER (WHERE status IN ('failed','dlq')),
    'delivery_rate_30d', round(100.0 * count(*) FILTER (WHERE status = 'sent') / NULLIF(count(*),0), 1),
    'pending_rate_30d', round(100.0 * count(*) FILTER (WHERE status IN ('pending','rate_limited')) / NULLIF(count(*),0), 1)
  ) INTO v_email
  FROM latest_email;

  WITH att AS (
    SELECT session_trace_id, status, detail, user_id, created_at
    FROM public.login_phase_events
    WHERE phase = 'auth.signin.attempt' AND created_at >= v_7d AND created_at <= v_end
  ), sessions_tried AS (
    SELECT DISTINCT session_trace_id FROM att WHERE session_trace_id IS NOT NULL
  ), sessions_succeeded AS (
    SELECT DISTINCT session_trace_id FROM att WHERE session_trace_id IS NOT NULL AND status = 'success'
  )
  SELECT jsonb_build_object(
    'attempts_7d', (SELECT count(*) FROM att),
    'success_7d', (SELECT count(*) FROM att WHERE status = 'success'),
    'error_7d', (SELECT count(*) FROM att WHERE status = 'error'),
    'rate_limited_7d', (SELECT count(*) FROM att WHERE status = 'rate_limited'),
    'unknown_account_7d', (SELECT count(*) FROM att WHERE status <> 'success' AND detail->>'accountExists' = 'false'),
    'wrong_credentials_7d', (SELECT count(*) FROM att WHERE status = 'error' AND detail->>'accountExists' = 'true'),
    'platform_failures_7d', (SELECT count(*) FROM att
       WHERE status = 'rate_limited'
          OR (status = 'error' AND detail->>'accountExists' IS NULL)),
    'success_rate', (SELECT round(100.0 * count(*) FILTER (WHERE status = 'success') / NULLIF(count(*),0), 1) FROM att),
    'platform_failure_rate', (SELECT round(100.0 * count(*) FILTER (
          WHERE status = 'rate_limited' OR (status = 'error' AND detail->>'accountExists' IS NULL)
        ) / NULLIF(count(*),0), 2) FROM att),
    'users_tried_7d', (SELECT count(*) FROM sessions_tried),
    'users_eventually_signed_in_7d', (SELECT count(*) FROM sessions_succeeded),
    'eventual_success_rate', (SELECT round(100.0 * (SELECT count(*) FROM sessions_succeeded) / NULLIF((SELECT count(*) FROM sessions_tried),0), 1))
  ) INTO v_signin;

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

    'roles', v_roles,
    'sms', v_sms,
    'otp', v_otp,
    'signin', v_signin,

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

    'auth', jsonb_build_object(
      'login_events_today', (SELECT count(*) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND phase = 'auth.signin.attempt'),
      'login_success_today', (SELECT count(*) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND phase = 'auth.signin.attempt' AND status = 'success'),
      'login_failures_today', (SELECT count(*) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND phase = 'auth.signin.attempt' AND status <> 'success'),
      'login_failures_7d', (SELECT count(*) FROM login_phase_events WHERE created_at >= v_7d AND created_at <= v_end AND phase = 'auth.signin.attempt' AND status <> 'success'),
      'login_events_7d', (SELECT count(*) FROM login_phase_events WHERE created_at >= v_7d AND created_at <= v_end AND phase = 'auth.signin.attempt'),
      'login_rate_limited_today', (SELECT count(*) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND phase = 'auth.signin.attempt' AND status = 'rate_limited'),
      'avg_login_ms_today', (SELECT round(avg((detail->>'totalMs')::numeric)) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND phase = 'auth.signin.attempt' AND (detail->>'totalMs') ~ '^[0-9]+$'),
      'median_login_ms_today', (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (detail->>'totalMs')::numeric)) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND phase = 'auth.signin.attempt' AND (detail->>'totalMs') ~ '^[0-9]+$'),
      'p95_login_ms_today', (SELECT round(percentile_cont(0.95) WITHIN GROUP (ORDER BY (detail->>'totalMs')::numeric)) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND phase = 'auth.signin.attempt' AND (detail->>'totalMs') ~ '^[0-9]+$'),
      'login_attempts_over_60s_today', (SELECT count(*) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND phase = 'auth.signin.attempt' AND (detail->>'totalMs') ~ '^[0-9]+$' AND (detail->>'totalMs')::numeric > 60000),
      'login_users_over_60s_today', (SELECT count(DISTINCT user_id) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND phase = 'auth.signin.attempt' AND (detail->>'totalMs') ~ '^[0-9]+$' AND (detail->>'totalMs')::numeric > 60000),
      'avg_phase_ms_today', (SELECT round(avg(duration_ms)) FROM login_phase_events WHERE created_at BETWEEN v_start AND v_end AND duration_ms IS NOT NULL),
      'otp_attempts_today', (SELECT count(*) FROM otp_login_audit WHERE created_at BETWEEN v_start AND v_end),
      'otp_failures_today', (SELECT count(*) FROM otp_login_audit WHERE created_at BETWEEN v_start AND v_end AND outcome <> 'success')
    ),

    'security', jsonb_build_object(
      'signup_attempts_today', (SELECT count(*) FROM signup_attempts WHERE created_at BETWEEN v_start AND v_end),
      'signup_blocked_today', (SELECT count(*) FROM signup_attempts
        WHERE created_at BETWEEN v_start AND v_end AND status <> 'allowed' AND status <> 'abandoned'),
      'signup_allowed_today', (SELECT count(*) FROM signup_attempts
        WHERE created_at BETWEEN v_start AND v_end AND status = 'allowed'),
      'signup_abandoned_today', (SELECT count(*) FROM signup_attempts
        WHERE created_at BETWEEN v_start AND v_end AND status = 'abandoned'),
      'blocked_ips_total', (SELECT count(*) FROM blocked_signup_ips),
      'fraud_blocks_active', (SELECT count(*) FROM fraud_identity_blocks WHERE status = 'active'),
      'fraud_blocks_today', (SELECT count(*) FROM fraud_identity_blocks WHERE created_at BETWEEN v_start AND v_end),
      'privileged_accounts', (SELECT count(DISTINCT user_id) FROM user_roles WHERE role IN ('super_admin','manager','cto','ceo','cfo','coo','access_admin')),
      'audit_writes_today', (SELECT count(*) FROM audit_logs WHERE created_at BETWEEN v_start AND v_end),
      'rls_tables', (SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relrowsecurity),
      'public_tables', (SELECT count(*) FROM pg_tables WHERE schemaname='public')
    ),

    'infra', jsonb_build_object(
      'db_size_bytes', pg_database_size(current_database()),
      'connections', (SELECT count(*) FROM pg_stat_activity),
      'max_connections', (SELECT setting::int FROM pg_settings WHERE name='max_connections'),
      'deadlocks', (SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()),
      'deadlocks_today', v_day_deadlocks,
      'rollbacks', v_day_rollbacks,
      'commits', v_day_commits,
      'rollback_baseline_at', v_prev_at,
      'rollback_trustworthy', v_infra_trustworthy,
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
      'runs_24h', (SELECT count(*) FROM cron.job_run_details WHERE start_time >= v_end - interval '24 hours' AND start_time <= v_end),
      'failed_24h', (SELECT count(*) FROM cron.job_run_details WHERE start_time >= v_end - interval '24 hours' AND start_time <= v_end AND status <> 'succeeded'),
      'failing', COALESCE((
        SELECT jsonb_agg(x) FROM (
          SELECT COALESCE(j.jobname, '(unscheduled) ' || COALESCE(substring(d.command from 'public\.([a-zA-Z_0-9]+)'), 'unknown')) AS jobname,
                 count(*) AS n, max(left(COALESCE(d.return_message,''),140)) AS last_error,
                 (j.jobid IS NULL) AS unscheduled
          FROM cron.job_run_details d LEFT JOIN cron.job j USING (jobid)
          WHERE d.start_time >= v_end - interval '24 hours' AND d.start_time <= v_end AND d.status <> 'succeeded'
          GROUP BY j.jobid, j.jobname, d.command ORDER BY n DESC LIMIT 8
        ) x), '[]'::jsonb)
    ),

    'email', jsonb_build_object(
      'sent_today', (SELECT count(*) FROM email_send_log WHERE created_at BETWEEN v_start AND v_end),
      'delivered_today', (SELECT count(*) FROM email_send_log WHERE created_at BETWEEN v_start AND v_end AND status = 'sent'),
      'failed_today', (SELECT count(*) FROM email_send_log WHERE created_at BETWEEN v_start AND v_end AND status IN ('failed','dlq')),
      'pending_today', (SELECT count(*) FROM email_send_log WHERE created_at BETWEEN v_start AND v_end AND status IN ('pending','rate_limited')),
      'suppressed_today', (SELECT count(*) FROM email_send_log WHERE created_at BETWEEN v_start AND v_end AND status = 'suppressed'),
      'failed_7d', (SELECT count(*) FROM email_send_log WHERE created_at >= v_7d AND created_at <= v_end AND status IN ('failed','dlq')),
      'sent_7d', (SELECT count(*) FROM email_send_log WHERE created_at >= v_7d AND created_at <= v_end)
    ) || v_email,

    'slow_queries', v_slow
  ) INTO v;

  RETURN v;
END;
$function$
