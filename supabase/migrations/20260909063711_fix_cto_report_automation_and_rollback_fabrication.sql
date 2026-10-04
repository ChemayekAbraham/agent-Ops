-- Fix three fabrication bugs in the CTO/board reporting RPCs, found while
-- verifying the 2026-09-08 Daily CTO Report and Board Technology Memo
-- against production data ahead of a board meeting. Both documents named
-- automations as failing that never failed, and the CTO report carried a
-- 14.11% "Breached" rollback rate that was actually a lifetime ratio.
--
-- Bugs fixed, all in get_cto_daily_report / get_cto_diagnostics /
-- get_cto_issue_intelligence:
--
-- 1. Missing upper time bound on the "failing automations" queries
--    (`WHERE d.start_time >= v_end - interval '24 hours'` with no
--    `AND d.start_time <= v_end`). Calling the RPC for a past p_date after
--    the fact can leak in failures from after the report's own window.
--
-- 2. Failing-job queries INNER JOINed cron.job_run_details to cron.job,
--    which silently drops any run whose job has no current cron.job row —
--    e.g. public.email_queue_dispatch(), triggered ad-hoc via
--    cron.schedule_in_background rather than on a fixed schedule. This is
--    exactly backwards: the ad-hoc job was the one real automation problem
--    the week of 2026-09-08 (26 cancellations, a real email backlog), and
--    it was invisible in all three functions while six unrelated, healthy
--    named jobs were reported as failing instead. Switched to LEFT JOIN
--    with a derived "(unscheduled) <function_name>" label, grouped by that
--    label (not by the ephemeral per-run jobid) so repeated ad-hoc failures
--    collapse into one entry instead of one row per occurrence.
--
-- 3. get_cto_diagnostics computed "Transaction rollback rate" and
--    "Deadlocks since boot" as raw lifetime ratios straight from
--    pg_stat_database (since the last stats reset, ~150 days of uptime),
--    not a same-day figure — this is exactly the bug the daily-report RPC
--    was already fixed for on 2026-09-08 per mem/features/cto/daily-cto-report.md,
--    but the fix was never ported to get_cto_diagnostics. The lifetime
--    rollback ratio (~14.2%) is what showed up in the CTO report as a false
--    "14.11% Breached" P2 action item with a due date. Both metrics now read
--    from the day-over-day public.db_stat_snapshots delta (same mechanism
--    as get_cto_daily_report) and report "Unavailable" rather than a
--    misleading number when the prior day's snapshot doesn't exist or isn't
--    exactly p_date - 1.
--
-- 4. get_cto_daily_report's rollback trustworthiness gate only checked that
--    counters moved forward (v_snap_commit >= v_prev_commit), not that the
--    baseline snapshot's `day` was actually p_date - 1. A multi-day gap in
--    the daily snapshot cron (which has happened before — see
--    docs/investigations/Board_Memo_Preview_Generation_Prompt.md, Gate A)
--    would silently compute a multi-day rate and report it as a single
--    day's figure. Added an explicit v_prev_day = p_date - 1 check.
--
-- 5. Sign-in "sessions" in get_cto_daily_report were counted by distinct
--    user_id, which is populated on roughly 10% of sign-in attempts (most
--    are pre-authentication). This undercounted weekly session volume by
--    roughly 14x while the success *rate* still looked plausible. Switched
--    to session_trace_id, which is present on every attempt.
--
-- 6. db_stat_snapshots had no column to store a daily deadlock count, so a
--    real day-over-day deadlock delta could never be computed even after
--    fixing the trustworthiness gate. Added the column and started
--    capturing it in the same daily upsert that already captures commits
--    and rollbacks.
--
-- Verified post-fix against production for 2026-09-08: 0 of 152 scheduled
-- automations failed (previously reported as 6); the one real automation
-- issue (email_queue_dispatch, 4 failures in the 24h window, 26 over the
-- week) now surfaces correctly; rollback rate correctly reports
-- "Unavailable" for that date (no same-day snapshot existed); sign-in
-- sessions for the week ending 2026-09-08 correctly show 724 tried / 595
-- eventually succeeded (was 52 / 43).

ALTER TABLE public.db_stat_snapshots ADD COLUMN IF NOT EXISTS deadlocks bigint;

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

  -- Trustworthy only when the prior snapshot is exactly the day before AND
  -- counters moved forward. A stale/missing/multi-day-gapped baseline must
  -- never be silently treated as "0 rollbacks today" or averaged into a
  -- same-day rate — both read as false reassurance to a board.
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

  -- Sign-in "sessions" are keyed on session_trace_id, not user_id: user_id is
  -- only populated on a small fraction of attempts (pre-authentication
  -- events, anonymous drop-off, etc.), so a user_id-keyed count silently
  -- undercounts real session volume by an order of magnitude while the
  -- success *rate* still looks plausible. session_trace_id is present on
  -- every phase event regardless of whether the user is known yet.
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
$function$;

CREATE OR REPLACE FUNCTION public.get_cto_diagnostics(p_date date DEFAULT ((now() AT TIME ZONE 'Africa/Kampala'::text))::date)
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
  v_errors jsonb := '[]'::jsonb;
  v_api jsonb := '[]'::jsonb;
  v_db jsonb := '{}'::jsonb;
  v_jobs jsonb := '[]'::jsonb;
  v_frontend jsonb := '{}'::jsonb;
  v_auth jsonb := '{}'::jsonb;
  v_infra jsonb := '[]'::jsonb;
  v_sec jsonb := '{}'::jsonb;
  v_reg jsonb := '{}'::jsonb;
  v_actions jsonb := '[]'::jsonb;
  v_total_today int := 0;
  v_users_today int := 0;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'manager')
    OR auth.role() = 'service_role' OR auth.uid() IS NULL
  ) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  WITH base AS (
    SELECT e.id, e.user_id,
           COALESCE(NULLIF(e.route,''),'unknown') AS route,
           COALESCE(NULLIF(e.message,''),'unknown') AS message,
           e.component_stack, COALESCE(e.user_agent,'') AS ua, COALESCE(e.context,'{}'::jsonb) AS ctx,
           e.created_at, e.label, e.role
    FROM client_error_reports e
    WHERE e.created_at >= v_7d AND e.created_at <= v_end
  ), norm AS (
    SELECT b.*,
      (b.created_at >= v_start AND b.created_at <= v_end) AS is_today,
      (b.created_at >= v_prev_start AND b.created_at < v_start) AS is_prev,
      left(regexp_replace(b.message,'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{4,}','#','g'),160) AS sig,
      CASE
        WHEN b.ua ILIKE '%Firefox%' THEN 'Firefox'
        WHEN b.ua ILIKE '%Edg/%' THEN 'Edge'
        WHEN b.ua ILIKE '%OPR/%' OR b.ua ILIKE '%Opera%' THEN 'Opera'
        WHEN b.ua ILIKE '%SamsungBrowser%' THEN 'Samsung Internet'
        WHEN b.ua ILIKE '%Chrome%' THEN 'Chrome'
        WHEN b.ua ILIKE '%Safari%' THEN 'Safari'
        WHEN b.ua = '' THEN 'Unknown'
        ELSE 'Other'
      END AS browser,
      CASE
        WHEN b.ua ILIKE '%Android%' THEN 'Android'
        WHEN b.ua ILIKE '%iPhone%' OR b.ua ILIKE '%iPad%' OR b.ua ILIKE '%iPod%' THEN 'iOS'
        WHEN b.ua ILIKE '%Windows%' THEN 'Windows'
        WHEN b.ua ILIKE '%Mac OS%' THEN 'macOS'
        WHEN b.ua ILIKE '%Linux%' THEN 'Linux'
        ELSE 'Unknown'
      END AS os,
      CASE
        WHEN b.ua ILIKE '%iPad%' OR b.ua ILIKE '%Tablet%' THEN 'Tablet'
        WHEN b.ua ILIKE '%Mobi%' OR b.ua ILIKE '%Android%' OR b.ua ILIKE '%iPhone%' THEN 'Mobile'
        WHEN b.ua = '' THEN 'Unknown'
        ELSE 'Desktop'
      END AS device,
      NULLIF(b.ctx->>'filename','') AS src_file,
      NULLIF(b.ctx->>'lineno','') AS src_line,
      NULLIF(b.ctx->>'colno','') AS src_col,
      NULLIF(b.ctx->>'source','') AS capture_source,
      left(COALESCE(NULLIF(b.ctx->>'stack',''), NULLIF(b.component_stack,''),''),700) AS stack,
      NULLIF(btrim(split_part(COALESCE(b.component_stack,''), E'\n', 2)),'') AS component
    FROM base b
  ), agg AS (
    SELECT n.sig,
      count(*) FILTER (WHERE n.is_today) AS today_n,
      count(*) FILTER (WHERE n.is_prev) AS prev_n,
      count(*) AS n_7d,
      count(DISTINCT n.user_id) FILTER (WHERE n.is_today) AS users_today,
      count(DISTINCT n.user_id) AS users_7d,
      min(n.created_at) AS first_seen,
      max(n.created_at) AS last_seen,
      (array_agg(n.message ORDER BY n.created_at DESC))[1] AS sample_message,
      (array_agg(n.route ORDER BY n.created_at DESC))[1] AS sample_route,
      (array_agg(n.user_id ORDER BY n.created_at DESC) FILTER (WHERE n.user_id IS NOT NULL))[1] AS sample_user,
      (array_agg(n.src_file ORDER BY n.created_at DESC) FILTER (WHERE n.src_file IS NOT NULL))[1] AS src_file,
      (array_agg(n.src_line ORDER BY n.created_at DESC) FILTER (WHERE n.src_line IS NOT NULL))[1] AS src_line,
      (array_agg(n.src_col ORDER BY n.created_at DESC) FILTER (WHERE n.src_col IS NOT NULL))[1] AS src_col,
      (array_agg(n.capture_source ORDER BY n.created_at DESC) FILTER (WHERE n.capture_source IS NOT NULL))[1] AS capture_source,
      (array_agg(n.stack ORDER BY n.created_at DESC) FILTER (WHERE n.stack <> ''))[1] AS stack,
      (array_agg(n.component ORDER BY n.created_at DESC) FILTER (WHERE n.component IS NOT NULL))[1] AS component,
      (array_agg(n.label ORDER BY n.created_at DESC) FILTER (WHERE n.label IS NOT NULL))[1] AS label,
      (array_agg(n.role ORDER BY n.created_at DESC) FILTER (WHERE n.role IS NOT NULL))[1] AS role
    FROM norm n GROUP BY n.sig
  ), brk_browser AS (
    SELECT sig, jsonb_object_agg(browser, c) AS m FROM (
      SELECT sig, browser, count(*) c FROM norm GROUP BY 1,2) t GROUP BY 1
  ), brk_os AS (
    SELECT sig, jsonb_object_agg(os, c) AS m FROM (
      SELECT sig, os, count(*) c FROM norm GROUP BY 1,2) t GROUP BY 1
  ), brk_device AS (
    SELECT sig, jsonb_object_agg(device, c) AS m FROM (
      SELECT sig, device, count(*) c FROM norm GROUP BY 1,2) t GROUP BY 1
  ), brk_route AS (
    SELECT sig, jsonb_agg(jsonb_build_object('route', route, 'n', c) ORDER BY c DESC) AS m FROM (
      SELECT sig, route, count(*) c FROM norm GROUP BY 1,2 ORDER BY 3 DESC) t GROUP BY 1
  )
  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'occurrences_today')::int DESC, (row->>'occurrences_7d')::int DESC), '[]'::jsonb)
  INTO v_errors
  FROM (
    SELECT jsonb_build_object(
      'signature', a.sig,
      'message', a.sample_message,
      'error_code', COALESCE(cls->>'category','Unclassified'),
      'stack', NULLIF(a.stack,''),
      'source_file', a.src_file,
      'source_line', a.src_line,
      'source_column', a.src_col,
      'capture_source', a.capture_source,
      'component', a.component,
      'route', a.sample_route,
      'routes', COALESCE(br.m,'[]'::jsonb),
      'boundary_label', a.label,
      'actor_role', a.role,
      'sample_user_id', a.sample_user,
      'browsers', COALESCE(bb.m,'{}'::jsonb),
      'operating_systems', COALESCE(bo.m,'{}'::jsonb),
      'devices', COALESCE(bd.m,'{}'::jsonb),
      'occurrences_today', a.today_n,
      'occurrences_prev_day', a.prev_n,
      'occurrences_7d', a.n_7d,
      'affected_users_today', a.users_today,
      'affected_users_7d', a.users_7d,
      'first_seen', a.first_seen,
      'last_seen', a.last_seen,
      'severity', CASE
        WHEN a.today_n >= 400 OR a.users_today >= 25 THEN 'Critical'
        WHEN a.today_n >= 100 OR a.users_today >= 10 THEN 'High'
        WHEN a.today_n >= 20 OR a.users_today >= 3 THEN 'Medium'
        ELSE 'Low' END,
      'category', cls->>'category',
      'root_cause', cls->>'root_cause',
      'suggested_fix', cls->>'fix',
      'owner_team', cls->>'team',
      'feature_area', CASE
        WHEN a.sample_route ILIKE '/dashboard/agent%' THEN 'Agent field operations'
        WHEN a.sample_route ILIKE '%tenant%' THEN 'Tenant experience'
        WHEN a.sample_route ILIKE '%landlord%' THEN 'Landlord payouts'
        WHEN a.sample_route ILIKE '%wallet%' OR a.sample_route ILIKE '%withdraw%' OR a.sample_route ILIKE '%deposit%' THEN 'Wallet and money movement'
        WHEN a.sample_route ILIKE '%auth%' OR a.sample_route ILIKE '%login%' THEN 'Authentication'
        WHEN a.sample_route ILIKE '%cfo%' OR a.sample_route ILIKE '%finops%' OR a.sample_route ILIKE '%admin%' THEN 'Back office'
        ELSE 'General platform' END,
      'revenue_exposed', (a.sample_route ILIKE '%wallet%' OR a.sample_route ILIKE '%withdraw%' OR a.sample_route ILIKE '%deposit%' OR a.sample_route ILIKE '%payout%' OR a.sample_route ILIKE '%rent%'),
      'data_integrity_risk', (cls->>'category') IN ('Authorisation','Offline storage','Edge function'),
      'production_blocking', (a.today_n >= 400 OR a.users_today >= 25),
      'expected_resolution', CASE
        WHEN a.today_n >= 400 OR a.users_today >= 25 THEN 'Same day (P1)'
        WHEN a.today_n >= 100 OR a.users_today >= 10 THEN '48 hours (P2)'
        WHEN a.today_n >= 20 THEN 'This sprint (P3)'
        ELSE 'Backlog (P4)' END
    ) AS row
    FROM agg a
    LEFT JOIN brk_browser bb ON bb.sig = a.sig
    LEFT JOIN brk_os bo ON bo.sig = a.sig
    LEFT JOIN brk_device bd ON bd.sig = a.sig
    LEFT JOIN brk_route br ON br.sig = a.sig
    CROSS JOIN LATERAL public.cto_classify_error(a.sample_message) AS cls
    WHERE a.today_n > 0 OR a.n_7d > 0
    ORDER BY a.today_n DESC, a.n_7d DESC
    LIMIT 20
  ) z;

  SELECT count(*), count(DISTINCT user_id) INTO v_total_today, v_users_today
  FROM client_error_reports WHERE created_at >= v_start AND created_at <= v_end;

  SELECT jsonb_build_object(
    'by_route', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT COALESCE(NULLIF(route,''),'unknown') AS route, count(*) AS n, count(DISTINCT user_id) AS users
        FROM client_error_reports WHERE created_at >= v_start AND created_at <= v_end
        GROUP BY 1 ORDER BY 2 DESC LIMIT 12) x),'[]'::jsonb),
    'by_browser', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT CASE
          WHEN user_agent ILIKE '%Firefox%' THEN 'Firefox'
          WHEN user_agent ILIKE '%Edg/%' THEN 'Edge'
          WHEN user_agent ILIKE '%SamsungBrowser%' THEN 'Samsung Internet'
          WHEN user_agent ILIKE '%Chrome%' THEN 'Chrome'
          WHEN user_agent ILIKE '%Safari%' THEN 'Safari'
          ELSE 'Other' END AS browser, count(*) AS n, count(DISTINCT user_id) AS users
        FROM client_error_reports WHERE created_at >= v_start AND created_at <= v_end
        GROUP BY 1 ORDER BY 2 DESC) x),'[]'::jsonb),
    'by_os', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT CASE
          WHEN user_agent ILIKE '%Android%' THEN 'Android'
          WHEN user_agent ILIKE '%iPhone%' OR user_agent ILIKE '%iPad%' THEN 'iOS'
          WHEN user_agent ILIKE '%Windows%' THEN 'Windows'
          WHEN user_agent ILIKE '%Mac OS%' THEN 'macOS'
          WHEN user_agent ILIKE '%Linux%' THEN 'Linux'
          ELSE 'Unknown' END AS os, count(*) AS n
        FROM client_error_reports WHERE created_at >= v_start AND created_at <= v_end
        GROUP BY 1 ORDER BY 2 DESC) x),'[]'::jsonb),
    'by_device', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT CASE
          WHEN user_agent ILIKE '%iPad%' OR user_agent ILIKE '%Tablet%' THEN 'Tablet'
          WHEN user_agent ILIKE '%Mobi%' OR user_agent ILIKE '%Android%' OR user_agent ILIKE '%iPhone%' THEN 'Mobile'
          ELSE 'Desktop' END AS device, count(*) AS n
        FROM client_error_reports WHERE created_at >= v_start AND created_at <= v_end
        GROUP BY 1 ORDER BY 2 DESC) x),'[]'::jsonb),
    'by_component', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT COALESCE(NULLIF(btrim(split_part(COALESCE(component_stack,''), E'\n', 2)),''), COALESCE(label,'unknown boundary')) AS component,
               count(*) AS n, count(DISTINCT user_id) AS users
        FROM client_error_reports WHERE created_at >= v_start AND created_at <= v_end
        GROUP BY 1 ORDER BY 2 DESC LIMIT 10) x),'[]'::jsonb),
    'by_file', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT COALESCE(NULLIF(context->>'filename',''),'(not captured)') AS file, count(*) AS n
        FROM client_error_reports WHERE created_at >= v_start AND created_at <= v_end
        GROUP BY 1 ORDER BY 2 DESC LIMIT 10) x),'[]'::jsonb),
    'compat_events', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT event_type, count(*) AS n, max(left(COALESCE(error_message,''),120)) AS sample
        FROM browser_compat_events WHERE created_at >= v_start AND created_at <= v_end
        GROUP BY 1 ORDER BY 2 DESC LIMIT 8) x),'[]'::jsonb)
  ) INTO v_frontend;

  WITH ep AS (
    SELECT COALESCE(
             (regexp_match(message,'functions/v1/([a-z0-9_-]+)'))[1],
             (regexp_match(COALESCE(context->>'href',''),'functions/v1/([a-z0-9_-]+)'))[1],
             NULLIF(context->>'endpoint','')
           ) AS endpoint,
           message, created_at, user_id
    FROM client_error_reports
    WHERE created_at >= v_7d AND created_at <= v_end
  )
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'failed_requests')::int DESC),'[]'::jsonb) INTO v_api
  FROM (
    SELECT jsonb_build_object(
      'endpoint', '/functions/v1/' || endpoint,
      'method','POST',
      'failed_requests', count(*),
      'affected_users', count(DISTINCT user_id),
      'first_seen', min(created_at),
      'last_seen', max(created_at),
      'status_codes', CASE WHEN bool_or(message ILIKE '%401%') THEN '401' WHEN bool_or(message ILIKE '%403%') THEN '403' WHEN bool_or(message ILIKE '%500%') THEN '500' ELSE 'non-2xx' END,
      'sample_error', left(max(message),200),
      'root_cause', (public.cto_classify_error(max(message))->>'root_cause'),
      'recommended_fix', (public.cto_classify_error(max(message))->>'fix')
    ) AS x
    FROM ep WHERE endpoint IS NOT NULL
    GROUP BY endpoint ORDER BY count(*) DESC LIMIT 15
  ) t;

  BEGIN
    SELECT jsonb_build_object(
      'slow_queries', COALESCE((SELECT jsonb_agg(x) FROM (
          SELECT jsonb_build_object(
            'query', left(query, 900),
            'calls', calls,
            'mean_ms', round(mean_exec_time::numeric,2),
            'max_ms', round(max_exec_time::numeric,2),
            'total_ms', round(total_exec_time::numeric,1),
            'stddev_ms', round(stddev_exec_time::numeric,2),
            'rows_returned', rows,
            'cache_hit_pct', round(100.0*shared_blks_hit/NULLIF(shared_blks_hit+shared_blks_read,0),1),
            'disk_reads', shared_blks_read,
            'recommendation', CASE
              WHEN shared_blks_read > shared_blks_hit THEN 'Reading mostly from disk - add a covering index on the filtered/ordered columns.'
              WHEN mean_exec_time > 1000 THEN 'Over 1s average - run EXPLAIN (ANALYZE, BUFFERS) and index the predicate columns.'
              WHEN calls > 100000 THEN 'Very high call volume - cache the result or batch the callers.'
              ELSE 'Monitor; within acceptable range for its volume.' END
          ) AS x
          FROM extensions.pg_stat_statements
          WHERE query NOT ILIKE '%pg_stat%' AND calls > 20
          ORDER BY total_exec_time DESC LIMIT 10) y),'[]'::jsonb),
      'missing_indexes', COALESCE((SELECT jsonb_agg(x) FROM (
          SELECT jsonb_build_object(
            'table', relname,
            'sequential_scans', seq_scan,
            'rows_read_sequentially', seq_tup_read,
            'index_scans', COALESCE(idx_scan,0),
            'live_rows', n_live_tup,
            'recommendation', 'Sequential scans dominate this table - add an index on the columns used in the WHERE/ORDER BY of its hottest query.'
          ) AS x
          FROM pg_stat_user_tables
          WHERE schemaname='public' AND seq_scan > 500 AND n_live_tup > 5000 AND seq_scan > COALESCE(idx_scan,0)
          ORDER BY seq_tup_read DESC LIMIT 8) y),'[]'::jsonb),
      'lock_waits', (SELECT count(*) FROM pg_locks WHERE NOT granted),
      'blocked_queries', COALESCE((SELECT jsonb_agg(x) FROM (
          SELECT jsonb_build_object('pid', pid, 'wait_event', wait_event_type||'/'||COALESCE(wait_event,''), 'query', left(query,200), 'waiting_for', round(EXTRACT(epoch FROM (now()-query_start))::numeric,1)) AS x
          FROM pg_stat_activity WHERE wait_event_type = 'Lock' LIMIT 5) y),'[]'::jsonb),
      'bloat_candidates', COALESCE((SELECT jsonb_agg(x) FROM (
          SELECT jsonb_build_object('table', relname, 'dead_rows', n_dead_tup, 'live_rows', n_live_tup, 'last_autovacuum', last_autovacuum) AS x
          FROM pg_stat_user_tables WHERE schemaname='public' AND n_dead_tup > 20000
          ORDER BY n_dead_tup DESC LIMIT 5) y),'[]'::jsonb),
      'note', 'Per-query EXPLAIN plans are not captured in a read-only report - run EXPLAIN (ANALYZE, BUFFERS) on the statements listed above.'
    ) INTO v_db;
  EXCEPTION WHEN OTHERS THEN
    v_db := jsonb_build_object('slow_queries','[]'::jsonb,'missing_indexes','[]'::jsonb,'note','Query statistics unavailable.');
  END;

  BEGIN
    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'failures_24h')::int DESC),'[]'::jsonb) INTO v_jobs
    FROM (
      SELECT jsonb_build_object(
        'automation', COALESCE(j.jobname, '(unscheduled) ' || COALESCE(substring(min(d.command) from 'public\.([a-zA-Z_0-9]+)'), 'unknown')),
        'schedule', COALESCE(j.schedule, 'on-demand'),
        'command', left(COALESCE(j.command, min(d.command)), 220),
        'active', COALESCE(j.active, true),
        'unscheduled', (j.jobid IS NULL),
        'failures_24h', count(*) FILTER (WHERE d.status <> 'succeeded'),
        'runs_24h', count(*),
        'last_failure_at', max(d.start_time) FILTER (WHERE d.status <> 'succeeded'),
        'last_success_at', max(d.end_time) FILTER (WHERE d.status='succeeded'),
        'exception', left(COALESCE((array_agg(d.return_message ORDER BY d.start_time DESC) FILTER (WHERE d.status <> 'succeeded'))[1],''), 600),
        'retry_status', CASE WHEN count(*) FILTER (WHERE d.status='succeeded') > 0 THEN 'Recovered on a later run in the window' ELSE 'No successful run in the last 24h' END,
        'recommended_fix', 'Run the job body manually against the same arguments, capture the exception above, and gate the failing step.'
      ) AS x
      FROM cron.job_run_details d
      LEFT JOIN cron.job j ON j.jobid = d.jobid
      WHERE d.start_time >= v_end - interval '24 hours' AND d.start_time <= v_end
      GROUP BY j.jobid, j.jobname, j.schedule, j.command, j.active
      HAVING count(*) FILTER (WHERE d.status <> 'succeeded') > 0
      ORDER BY 1 LIMIT 15
    ) t;
  EXCEPTION WHEN OTHERS THEN v_jobs := '[]'::jsonb; END;

  SELECT jsonb_build_object(
    'login_attempts', (SELECT count(*) FROM login_phase_events WHERE created_at >= v_start AND created_at <= v_end),
    'login_failures', (SELECT count(*) FROM login_phase_events WHERE created_at >= v_start AND created_at <= v_end AND status <> 'success'),
    'failure_breakdown', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT CASE
          WHEN COALESCE(detail->>'reason', detail->>'message','') ILIKE '%invalid login%' OR COALESCE(detail->>'reason',detail->>'message','') ILIKE '%password%' THEN 'Invalid password'
          WHEN COALESCE(detail->>'reason', detail->>'message','') ILIKE '%otp%expired%' OR COALESCE(detail->>'reason',detail->>'message','') ILIKE '%expired%' THEN 'Expired OTP'
          WHEN COALESCE(detail->>'reason', detail->>'message','') ILIKE '%otp%' THEN 'Invalid OTP'
          WHEN COALESCE(detail->>'reason', detail->>'message','') ILIKE '%timeout%' OR COALESCE(detail->>'reason',detail->>'message','') ILIKE '%network%' OR COALESCE(detail->>'reason',detail->>'message','') ILIKE '%fetch%' THEN 'Network timeout'
          WHEN COALESCE(detail->>'reason', detail->>'message','') ILIKE '%oauth%' OR COALESCE(detail->>'reason',detail->>'message','') ILIKE '%google%' THEN 'OAuth / Google'
          WHEN COALESCE(detail->>'reason', detail->>'message','') ILIKE '%jwt%' OR COALESCE(detail->>'reason',detail->>'message','') ILIKE '%claim%' THEN 'JWT verification'
          WHEN COALESCE(detail->>'reason', detail->>'message','') ILIKE '%rate%' OR COALESCE(detail->>'reason',detail->>'message','') ILIKE '%too many%' THEN 'Rate limited'
          WHEN COALESCE(detail->>'reason', detail->>'message','') = '' THEN 'Unclassified (' || phase || ')'
          ELSE left(COALESCE(detail->>'reason', detail->>'message'),60) END AS reason,
          count(*) AS n, count(DISTINCT user_id) AS users
        FROM login_phase_events
        WHERE created_at >= v_start AND created_at <= v_end AND status <> 'success'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 12) x),'[]'::jsonb),
    'slowest_phases', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT phase, round(avg(duration_ms)) AS avg_ms, max(duration_ms) AS max_ms, count(*) AS n
        FROM login_phase_events WHERE created_at >= v_start AND created_at <= v_end AND duration_ms IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC LIMIT 6) x),'[]'::jsonb),
    'otp_breakdown', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT outcome, COALESCE(NULLIF(reason,''),'-') AS reason, COALESCE(NULLIF(stage,''),'-') AS stage, count(*) AS n
        FROM otp_login_audit WHERE created_at >= v_start AND created_at <= v_end
        GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 12) x),'[]'::jsonb),
    'otp_identity_mismatch', (SELECT count(*) FROM otp_login_audit WHERE created_at >= v_start AND created_at <= v_end AND expected_user_id IS NOT NULL AND actual_user_id IS NOT NULL AND expected_user_id <> actual_user_id),
    'device_issues', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT event_type, COALESCE(platform,'unknown') AS platform, count(*) AS n
        FROM install_attempt_events WHERE created_at >= v_start AND created_at <= v_end
        GROUP BY 1,2 ORDER BY 3 DESC LIMIT 8) x),'[]'::jsonb)
  ) INTO v_auth;

  WITH snap AS (
    SELECT p_date AS day,
      s.xact_commit, s.xact_rollback, s.deadlocks,
      p.day AS prev_day, p.xact_commit AS prev_commit, p.xact_rollback AS prev_rollback, p.deadlocks AS prev_deadlocks
    FROM (SELECT 1) dummy
    LEFT JOIN public.db_stat_snapshots s ON s.day = p_date
    LEFT JOIN public.db_stat_snapshots p ON p.day = p_date - 1
  ),
  m AS (
    SELECT
      (SELECT count(*) FROM pg_stat_activity)::numeric AS conns,
      (SELECT setting::numeric FROM pg_settings WHERE name='max_connections') AS max_conns,
      (SELECT round(100.0*blks_hit/NULLIF(blks_hit+blks_read,0),2) FROM pg_stat_database WHERE datname=current_database()) AS cache_hit,
      (SELECT deadlocks FROM pg_stat_database WHERE datname=current_database())::numeric AS deadlocks_lifetime,
      pg_database_size(current_database())::numeric AS db_bytes,
      (SELECT count(*) FROM pg_locks WHERE NOT granted)::numeric AS waiting_locks,
      CASE WHEN snap.xact_commit IS NOT NULL AND snap.prev_commit IS NOT NULL AND snap.prev_day = p_date - 1
                AND snap.xact_commit >= snap.prev_commit AND snap.xact_rollback >= snap.prev_rollback
           THEN round(100.0 * (snap.xact_rollback - snap.prev_rollback) / NULLIF((snap.xact_commit - snap.prev_commit) + (snap.xact_rollback - snap.prev_rollback), 0), 2)
           ELSE NULL END AS rollback_pct_today,
      CASE WHEN snap.deadlocks IS NOT NULL AND snap.prev_deadlocks IS NOT NULL AND snap.prev_day = p_date - 1
                AND snap.deadlocks >= snap.prev_deadlocks
           THEN snap.deadlocks - snap.prev_deadlocks
           ELSE NULL END AS deadlocks_today
    FROM snap
  )
  SELECT COALESCE(jsonb_agg(x),'[]'::jsonb) INTO v_infra FROM (
    SELECT jsonb_build_object('metric','Connection saturation','current', round(100.0*conns/NULLIF(max_conns,0),1)||'% ('||conns||'/'||max_conns||')','threshold','80%','status', CASE WHEN conns/NULLIF(max_conns,0) > 0.8 THEN 'Breached' ELSE 'OK' END,'root_cause','Client pool leaks or long-running transactions holding sessions open.','impact','New requests are refused once the pool is exhausted.','action','Reduce idle-in-transaction time and raise the database instance size if sustained above 80%.') AS x FROM m
    UNION ALL SELECT jsonb_build_object('metric','Buffer cache hit ratio','current', cache_hit||'%','threshold','>= 99%','status', CASE WHEN cache_hit < 99 THEN 'Breached' ELSE 'OK' END,'root_cause','Working set is larger than shared memory, so reads fall through to disk.','impact','Higher query latency across the app.','action','Add indexes to the sequential-scan tables listed above or increase the database instance memory.') FROM m
    UNION ALL SELECT jsonb_build_object('metric','Database size','current', pg_size_pretty(db_bytes::bigint),'threshold','Review at 80% of provisioned disk','status','Informational','root_cause','Log and event tables grow fastest.','impact','Disk exhaustion halts writes.','action','Keep the nightly retention crons healthy; expand disk before 80% utilisation.') FROM m
    UNION ALL SELECT jsonb_build_object('metric','Deadlocks since boot','current', CASE WHEN deadlocks_today IS NULL THEN deadlocks_lifetime::text || ' lifetime (no trustworthy same-day snapshot pair)' ELSE deadlocks_today::text || ' today' END,'threshold','0 growth per day','status', CASE WHEN deadlocks_today IS NULL THEN 'Unavailable' WHEN deadlocks_today > 0 THEN 'Watch' ELSE 'OK' END,'root_cause','Two transactions locking the same rows in opposite order.','impact','Failed writes surfaced to users as generic errors.','action', CASE WHEN deadlocks_today IS NULL THEN 'Restore the daily db_stat_snapshots capture so a same-day deadlock delta can be computed instead of a lifetime counter.' ELSE 'Order multi-row updates consistently inside the RPCs that touch wallets and ledger.' END) FROM m
    UNION ALL SELECT jsonb_build_object('metric','Transaction rollback rate','current', CASE WHEN rollback_pct_today IS NULL THEN 'Unavailable' ELSE rollback_pct_today||'%' END,'threshold','< 2%','status', CASE WHEN rollback_pct_today IS NULL THEN 'Unavailable' WHEN rollback_pct_today > 2 THEN 'Breached' ELSE 'OK' END,'root_cause','Constraint/trigger rejections or aborted client transactions.','impact','User actions silently fail and are retried.','action', CASE WHEN rollback_pct_today IS NULL THEN 'No trustworthy same-day snapshot pair exists yet — restore the daily db_stat_snapshots capture before trusting this figure.' ELSE 'Trace the rejecting triggers and return actionable messages to the client.' END) FROM m
    UNION ALL SELECT jsonb_build_object('metric','Ungranted locks (now)','current', waiting_locks::text,'threshold','0','status', CASE WHEN waiting_locks > 0 THEN 'Watch' ELSE 'OK' END,'root_cause','A long transaction is blocking others.','impact','Requests queue and time out.','action','Identify the blocking pid and shorten the transaction.') FROM m
  ) t;

  SELECT jsonb_build_object(
    'signup_attempts', (SELECT count(*) FROM signup_attempts WHERE created_at >= v_start AND created_at <= v_end),
    'signup_blocked', (SELECT count(*) FROM signup_attempts WHERE created_at >= v_start AND created_at <= v_end AND status <> 'success'),
    'suspicious_ips', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT COALESCE(ip::text,'unknown') AS ip, count(*) AS attempts, count(DISTINCT COALESCE(phone,email)) AS distinct_identities, max(created_at) AS last_seen
        FROM signup_attempts WHERE created_at >= v_7d AND created_at <= v_end
        GROUP BY 1 HAVING count(*) >= 5 ORDER BY 2 DESC LIMIT 10) x),'[]'::jsonb),
    'brute_force_candidates', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT COALESCE(phone,'unknown') AS identity, count(*) AS failed_attempts, max(created_at) AS last_attempt
        FROM otp_login_audit WHERE created_at >= v_start AND created_at <= v_end AND outcome <> 'success'
        GROUP BY 1 HAVING count(*) >= 5 ORDER BY 2 DESC LIMIT 10) x),'[]'::jsonb),
    'identity_mismatch_attempts', (SELECT count(*) FROM otp_login_audit WHERE created_at >= v_start AND created_at <= v_end AND expected_user_id IS NOT NULL AND actual_user_id IS NOT NULL AND expected_user_id <> actual_user_id),
    'blocked_ips_added_today', (SELECT count(*) FROM blocked_signup_ips WHERE created_at >= v_start AND created_at <= v_end),
    'fraud_blocks_today', (SELECT count(*) FROM fraud_identity_blocks WHERE created_at >= v_start AND created_at <= v_end),
    'privilege_changes', COALESCE((SELECT jsonb_agg(x) FROM (
        SELECT action_type, COALESCE(table_name,'-') AS table_name, count(*) AS n, max(created_at) AS last_at
        FROM audit_logs
        WHERE created_at >= v_start AND created_at <= v_end
          AND (action_type ILIKE '%role%' OR table_name = 'user_roles' OR action_type ILIKE '%permission%' OR action_type ILIKE '%access%')
        GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10) x),'[]'::jsonb),
    'authorization_violations', (SELECT count(*) FROM client_error_reports WHERE created_at >= v_start AND created_at <= v_end AND (message ILIKE '%row-level security%' OR message ILIKE '%permission denied%' OR message ILIKE '%not authoris%' OR message ILIKE '%not authoriz%')),
    'injection_probes', (SELECT count(*) FROM client_error_reports WHERE created_at >= v_start AND created_at <= v_end AND (message ILIKE '%union select%' OR message ILIKE '%<script%' OR message ILIKE '%drop table%' OR message ILIKE '%onerror=%')),
    'note', 'SQL-injection, XSS and CSRF attempts are surfaced from application error signatures and blocked-signup telemetry; the platform has no dedicated WAF feed.'
  ) INTO v_sec;

  WITH t AS (
    SELECT left(regexp_replace(COALESCE(message,'unknown'),'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{4,}','#','g'),160) AS sig,
           count(*) FILTER (WHERE created_at >= v_start) AS today_n,
           count(*) FILTER (WHERE created_at < v_start) AS prev_n
    FROM client_error_reports WHERE created_at >= v_prev_start AND created_at <= v_end
    GROUP BY 1
  )
  SELECT jsonb_build_object(
    'new_errors', COALESCE((SELECT jsonb_agg(x) FROM (SELECT jsonb_build_object('error',sig,'today',today_n) AS x FROM t WHERE prev_n = 0 AND today_n > 0 ORDER BY today_n DESC LIMIT 10) y),'[]'::jsonb),
    'resolved_errors', COALESCE((SELECT jsonb_agg(x) FROM (SELECT jsonb_build_object('error',sig,'yesterday',prev_n) AS x FROM t WHERE today_n = 0 AND prev_n > 0 ORDER BY prev_n DESC LIMIT 10) y),'[]'::jsonb),
    'worsening', COALESCE((SELECT jsonb_agg(x) FROM (SELECT jsonb_build_object('error',sig,'yesterday',prev_n,'today',today_n,'delta',today_n-prev_n) AS x FROM t WHERE prev_n > 0 AND today_n > prev_n * 1.25 ORDER BY today_n-prev_n DESC LIMIT 10) y),'[]'::jsonb),
    'improving', COALESCE((SELECT jsonb_agg(x) FROM (SELECT jsonb_build_object('error',sig,'yesterday',prev_n,'today',today_n,'delta',today_n-prev_n) AS x FROM t WHERE today_n > 0 AND prev_n > today_n * 1.25 ORDER BY prev_n-today_n DESC LIMIT 10) y),'[]'::jsonb),
    'recurring', COALESCE((SELECT jsonb_agg(x) FROM (SELECT jsonb_build_object('error',sig,'yesterday',prev_n,'today',today_n) AS x FROM t WHERE prev_n > 0 AND today_n > 0 ORDER BY today_n DESC LIMIT 10) y),'[]'::jsonb)
  ) INTO v_reg;

  SELECT COALESCE(jsonb_agg(x),'[]'::jsonb) INTO v_actions FROM (
    SELECT jsonb_build_object(
      'issue', left(e->>'message',120),
      'priority', CASE e->>'severity' WHEN 'Critical' THEN 'P1' WHEN 'High' THEN 'P2' WHEN 'Medium' THEN 'P3' ELSE 'P4' END,
      'team', e->>'owner_team',
      'owner', 'On-call ' || (e->>'owner_team'),
      'due_date', (p_date + CASE e->>'severity' WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 7 ELSE 14 END)::text,
      'status','Open',
      'blockers', CASE WHEN COALESCE(e->>'stack','') = '' THEN 'No source-mapped stack captured for this signature' ELSE 'None recorded' END,
      'action', e->>'suggested_fix'
    ) AS x
    FROM jsonb_array_elements(v_errors) e
    WHERE (e->>'severity') IN ('Critical','High')
    LIMIT 10
  ) t1;

  v_actions := v_actions || COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'issue','Automation failing: ' || (j->>'automation'),
      'priority','P2','team','Backend','owner','On-call Backend',
      'due_date',(p_date + 1)::text,'status','Open',
      'blockers', COALESCE(NULLIF(j->>'exception',''),'No exception text captured'),
      'action', j->>'recommended_fix'))
    FROM jsonb_array_elements(v_jobs) j), '[]'::jsonb);

  v_actions := v_actions || COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'issue','Infrastructure: ' || (i->>'metric') || ' = ' || (i->>'current'),
      'priority','P2','team','Infrastructure','owner','On-call Infrastructure',
      'due_date',(p_date + 3)::text,'status','Open','blockers','None recorded',
      'action', i->>'action'))
    FROM jsonb_array_elements(v_infra) i WHERE i->>'status' = 'Breached'), '[]'::jsonb);

  RETURN jsonb_build_object(
    'date', p_date,
    'generated_at', now(),
    'summary', jsonb_build_object(
      'client_errors_today', v_total_today,
      'affected_users_today', v_users_today,
      'distinct_signatures', jsonb_array_length(v_errors),
      'critical_signatures', (SELECT count(*) FROM jsonb_array_elements(v_errors) e WHERE e->>'severity' = 'Critical'),
      'failing_automations', jsonb_array_length(v_jobs),
      'failing_endpoints', jsonb_array_length(v_api),
      'breached_infra_alerts', (SELECT count(*) FROM jsonb_array_elements(v_infra) i WHERE i->>'status' = 'Breached'),
      'open_action_items', jsonb_array_length(v_actions)
    ),
    'errors', v_errors,
    'frontend', v_frontend,
    'api_failures', v_api,
    'database', v_db,
    'automations', v_jobs,
    'auth', v_auth,
    'infrastructure', v_infra,
    'security', v_sec,
    'regression', v_reg,
    'action_items', v_actions
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_cto_issue_intelligence(p_date date DEFAULT ((now() AT TIME ZONE 'Africa/Kampala'::text))::date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_start timestamptz := (p_date::text || ' 00:00:00+03')::timestamptz;
  v_end   timestamptz := (p_date::text || ' 23:59:59.999+03')::timestamptz;
  v_prev_start timestamptz := v_start - interval '1 day';
  v_7d  timestamptz := v_end - interval '7 days';
  v_14d timestamptz := v_end - interval '14 days';
  v_30d timestamptz := v_end - interval '30 days';
  v_60d timestamptz := v_end - interval '60 days';
  v_issues jsonb := '[]'::jsonb;
  v_autos  jsonb := '[]'::jsonb;
  v_slow   jsonb := '[]'::jsonb;
  v_apis   jsonb := '[]'::jsonb;
  v_notif  jsonb := '{}'::jsonb;
  v_authj  jsonb := '{}'::jsonb;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'manager')
    OR auth.role() = 'service_role' OR auth.uid() IS NULL
  ) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  -- ============ 1. CLIENT / FRONTEND ERROR ISSUES ============
  WITH base AS (
    SELECT e.id, e.user_id, e.created_at, e.role,
           COALESCE(NULLIF(e.route,''),'unknown') AS route,
           COALESCE(NULLIF(e.message,''),'unknown') AS message,
           COALESCE(e.user_agent,'') AS ua,
           COALESCE(e.context,'{}'::jsonb) AS ctx,
           e.component_stack,
           left(regexp_replace(COALESCE(NULLIF(e.message,''),'unknown'),
                '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{4,}','#','g'),160) AS sig
    FROM client_error_reports e
    WHERE e.created_at >= v_60d AND e.created_at <= v_end
  ), agg AS (
    SELECT sig,
      count(*) FILTER (WHERE created_at >= v_start AND created_at <= v_end)        AS today_n,
      count(*) FILTER (WHERE created_at >= v_prev_start AND created_at < v_start)  AS prev_n,
      count(*) FILTER (WHERE created_at >= v_7d)                                   AS n_7d,
      count(*) FILTER (WHERE created_at >= v_14d AND created_at < v_7d)            AS n_prev7,
      count(*) FILTER (WHERE created_at >= v_30d)                                  AS n_30d,
      count(*) FILTER (WHERE created_at >= v_60d AND created_at < v_30d)           AS n_prev30,
      count(DISTINCT user_id) FILTER (WHERE created_at >= v_start)                 AS users_today,
      count(DISTINCT user_id) FILTER (WHERE created_at >= v_30d)                   AS users_30d,
      count(DISTINCT (created_at AT TIME ZONE 'Africa/Kampala')::date)
        FILTER (WHERE created_at >= v_30d)                                         AS active_days_30d,
      min(created_at) AS first_seen, max(created_at) AS last_seen,
      (array_agg(message ORDER BY created_at DESC))[1] AS sample_message,
      (array_agg(route   ORDER BY created_at DESC))[1] AS sample_route,
      (array_agg(user_id ORDER BY created_at DESC) FILTER (WHERE user_id IS NOT NULL))[1] AS sample_user,
      (array_agg(role    ORDER BY created_at DESC) FILTER (WHERE role IS NOT NULL))[1] AS sample_role,
      (array_agg(NULLIF(ctx->>'filename','') ORDER BY created_at DESC) FILTER (WHERE NULLIF(ctx->>'filename','') IS NOT NULL))[1] AS src_file,
      (array_agg(NULLIF(ctx->>'lineno','')   ORDER BY created_at DESC) FILTER (WHERE NULLIF(ctx->>'lineno','') IS NOT NULL))[1]   AS src_line,
      (array_agg(left(COALESCE(NULLIF(ctx->>'stack',''), NULLIF(component_stack,''),''),700) ORDER BY created_at DESC)
        FILTER (WHERE COALESCE(NULLIF(ctx->>'stack',''), NULLIF(component_stack,'')) IS NOT NULL))[1] AS stack,
      (array_agg(NULLIF(btrim(split_part(COALESCE(component_stack,''), E'\n', 2)),'') ORDER BY created_at DESC)
        FILTER (WHERE NULLIF(btrim(split_part(COALESCE(component_stack,''), E'\n', 2)),'') IS NOT NULL))[1] AS component,
      min(created_at) FILTER (WHERE created_at >= v_start) AS first_today,
      max(created_at) FILTER (WHERE created_at <= v_end AND created_at >= v_start) AS last_today
    FROM base GROUP BY sig
  ), gaps AS (
    SELECT sig, max(gap_days) AS max_gap FROM (
      SELECT sig, d - lag(d) OVER (PARTITION BY sig ORDER BY d) AS gap_days
      FROM (SELECT DISTINCT sig, (created_at AT TIME ZONE 'Africa/Kampala')::date AS d FROM base) x
    ) y GROUP BY sig
  ), seg AS (
    SELECT sig, jsonb_object_agg(k, c) AS m FROM (
      SELECT sig,
        CASE WHEN ua ILIKE '%Firefox%' THEN 'Firefox' WHEN ua ILIKE '%Edg/%' THEN 'Edge'
             WHEN ua ILIKE '%SamsungBrowser%' THEN 'Samsung Internet' WHEN ua ILIKE '%Chrome%' THEN 'Chrome'
             WHEN ua ILIKE '%Safari%' THEN 'Safari' WHEN ua='' THEN 'Unknown' ELSE 'Other' END AS k,
        count(*) c FROM base WHERE created_at >= v_7d GROUP BY 1,2) t GROUP BY 1
  ), segos AS (
    SELECT sig, jsonb_object_agg(k, c) AS m FROM (
      SELECT sig,
        CASE WHEN ua ILIKE '%Android%' THEN 'Android'
             WHEN ua ILIKE '%iPhone%' OR ua ILIKE '%iPad%' THEN 'iOS'
             WHEN ua ILIKE '%Windows%' THEN 'Windows' WHEN ua ILIKE '%Mac OS%' THEN 'macOS'
             WHEN ua ILIKE '%Linux%' THEN 'Linux' ELSE 'Unknown' END AS k,
        count(*) c FROM base WHERE created_at >= v_7d GROUP BY 1,2) t GROUP BY 1
  ), segdev AS (
    SELECT sig, jsonb_object_agg(k, c) AS m FROM (
      SELECT sig,
        CASE WHEN ua ILIKE '%iPad%' OR ua ILIKE '%Tablet%' THEN 'Tablet'
             WHEN ua ILIKE '%Mobi%' OR ua ILIKE '%Android%' OR ua ILIKE '%iPhone%' THEN 'Mobile'
             WHEN ua='' THEN 'Unknown' ELSE 'Desktop' END AS k,
        count(*) c FROM base WHERE created_at >= v_7d GROUP BY 1,2) t GROUP BY 1
  ), rts AS (
    SELECT sig, jsonb_agg(jsonb_build_object('route', route, 'n', c) ORDER BY c DESC) AS m
    FROM (SELECT sig, route, count(*) c FROM base WHERE created_at >= v_7d GROUP BY 1,2) t GROUP BY 1
  )
  SELECT COALESCE(jsonb_agg(o ORDER BY (o->>'impact_score')::numeric DESC), '[]'::jsonb) INTO v_issues
  FROM (
    SELECT jsonb_build_object(
      'key', 'client_error:' || a.sig,
      'domain', 'Client errors',
      'title', left(a.sample_message, 150),
      'severity', sev.s,
      'executive_summary',
        format('%s users hit "%s" %s times on %s. %s',
               a.users_today, left(a.sample_message,90), a.today_n, COALESCE(a.sample_route,'unknown route'),
               CASE WHEN a.today_n > a.prev_n THEN 'Volume is rising against yesterday.'
                    WHEN a.today_n < a.prev_n THEN 'Volume is falling against yesterday.'
                    ELSE 'Volume is flat against yesterday.' END),
      'technical_summary',
        format('Signature "%s" classified as %s. Origin %s%s in component %s. Captured %s times over 30 days across %s active days.',
               left(a.sig,120), cls->>'category',
               COALESCE(a.src_file,'unknown file'), COALESCE(':'||a.src_line,''),
               COALESCE(a.component,'unknown'), a.n_30d, a.active_days_30d),
      'root_cause', cls->>'root_cause',
      'timeline', format('First seen %s, first occurrence today %s, last occurrence %s (UTC).',
                          to_char(a.first_seen,'YYYY-MM-DD HH24:MI'),
                          COALESCE(to_char(a.first_today,'HH24:MI'),'n/a'),
                          to_char(a.last_seen,'YYYY-MM-DD HH24:MI')),
      'frequency', format('%s today, %s over 7 days, %s over 30 days', a.today_n, a.n_7d, a.n_30d),
      'occurrences_today', a.today_n,
      'trend_yesterday', a.today_n - a.prev_n,
      'trend_7d',  a.n_7d  - a.n_prev7,
      'trend_30d', a.n_30d - a.n_prev30,
      'systems_affected', 'Web application (React SPA)',
      'services_affected', COALESCE(a.sample_route,'unknown route'),
      'apis_affected', CASE WHEN cls->>'category' IN ('Edge function','Network') THEN 'Supabase edge functions / REST data API' ELSE 'None identified' END,
      'tables_involved', CASE WHEN cls->>'category' = 'Authorisation' THEN 'Row-level-security protected tables on the failing route' ELSE 'Not determined from client telemetry' END,
      'functions_involved', COALESCE(a.component, 'Unresolved - source maps not uploaded'),
      'source_files', COALESCE(a.src_file,'not captured') || COALESCE(':'||a.src_line,''),
      'stack', NULLIF(a.stack,''),
      'source_map_location', CASE WHEN a.src_file IS NULL THEN 'No source map available' ELSE a.src_file || '.map' END,
      'sample_session_user', COALESCE(a.sample_user::text,'anonymous'),
      'actor_role', COALESCE(a.sample_role,'unknown'),
      'browsers', COALESCE(seg.m,'{}'::jsonb),
      'operating_systems', COALESCE(segos.m,'{}'::jsonb),
      'devices', COALESCE(segdev.m,'{}'::jsonb),
      'routes', COALESCE(rts.m,'[]'::jsonb),
      'business_impact',
        CASE WHEN cls->>'category' IN ('Edge function','Authorisation','Authentication') OR a.sample_route ILIKE '%wallet%' OR a.sample_route ILIKE '%withdraw%' OR a.sample_route ILIKE '%deposit%'
          THEN 'Money movement or access path is affected - transactions may be abandoned.'
          ELSE 'Degraded experience; no direct revenue path identified.' END,
      'user_impact', format('%s users today, %s users over 30 days', a.users_today, a.users_30d),
      'users_affected', a.users_today,
      'revenue_risk', CASE WHEN a.sample_route ILIKE '%wallet%' OR a.sample_route ILIKE '%withdraw%' OR a.sample_route ILIKE '%deposit%' OR a.sample_route ILIKE '%rent%' THEN 'High' WHEN cls->>'category' IN ('Edge function','Authentication','Authorisation') THEN 'Medium' ELSE 'Low' END,
      'owner', cls->>'team',
      'team', cls->>'team',
      'suggested_fix', cls->>'fix',
      'effort', CASE WHEN sev.s='Critical' THEN '1-2 engineer days' WHEN sev.s='High' THEN '0.5-1 engineer day' ELSE '2-4 engineer hours' END,
      'priority', CASE WHEN sev.s='Critical' THEN 'P1' WHEN sev.s='High' THEN 'P2' WHEN sev.s='Medium' THEN 'P3' ELSE 'P4' END,
      'status', CASE WHEN a.today_n=0 THEN 'Resolved today' WHEN a.today_n > a.prev_n THEN 'Open - regressing' ELSE 'Open' END,
      'is_new', (a.first_seen >= v_start),
      'is_recurring', (a.active_days_30d > 1),
      'days_active', a.active_days_30d,
      'previously_fixed', COALESCE(g.max_gap,0) >= 3,
      'getting_worse', a.today_n > a.prev_n,
      'blocking_production', (sev.s='Critical'),
      'investigation_active', false,
      'resolution_eta', CASE WHEN sev.s='Critical' THEN 'Today' WHEN sev.s='High' THEN 'This week' ELSE 'Next sprint' END,
      'impact_score',
        (a.users_today * 8) + (a.today_n * 1.0) + (a.n_7d * 0.15)
        + CASE WHEN sev.s='Critical' THEN 500 WHEN sev.s='High' THEN 200 WHEN sev.s='Medium' THEN 60 ELSE 0 END
        + CASE WHEN a.today_n > a.prev_n THEN 60 ELSE 0 END
        + CASE WHEN a.sample_route ILIKE '%wallet%' OR a.sample_route ILIKE '%withdraw%' OR a.sample_route ILIKE '%deposit%' THEN 250 ELSE 0 END
    ) AS o
    FROM agg a
    LEFT JOIN gaps g ON g.sig = a.sig
    LEFT JOIN seg  ON seg.sig = a.sig
    LEFT JOIN segos ON segos.sig = a.sig
    LEFT JOIN segdev ON segdev.sig = a.sig
    LEFT JOIN rts  ON rts.sig = a.sig
    CROSS JOIN LATERAL (SELECT public.cto_classify_error(a.sample_message) AS cls) c
    CROSS JOIN LATERAL (SELECT CASE
        WHEN a.users_today >= 25 OR a.today_n >= 400 THEN 'Critical'
        WHEN a.users_today >= 8  OR a.today_n >= 100 THEN 'High'
        WHEN a.users_today >= 2  OR a.today_n >= 20  THEN 'Medium'
        ELSE 'Low' END AS s) sev
    WHERE a.today_n > 0
    ORDER BY (a.users_today * 8 + a.today_n) DESC
    LIMIT 40
  ) z;

  -- ============ 2. AUTOMATION (CRON) DEEP DETAIL ============
  -- LEFT JOIN so ad-hoc/one-off jobs (no current cron.job row, e.g.
  -- cron.schedule_in_background triggers) are grouped by their derived
  -- command name instead of silently disappearing; bounded to v_end so a
  -- historical p_date can never pick up failures from after the report's
  -- own reporting window.
  BEGIN
    WITH runs AS (
      SELECT COALESCE(j.jobname, '(unscheduled) ' || COALESCE(substring(d.command from 'public\.([a-zA-Z_0-9]+)'), 'unknown')) AS jobname,
             COALESCE(j.schedule, 'on-demand') AS schedule,
             COALESCE(j.command, d.command) AS command,
             d.status, d.return_message, d.start_time, d.end_time,
             row_number() OVER (PARTITION BY COALESCE(j.jobname, '(unscheduled) ' || COALESCE(substring(d.command from 'public\.([a-zA-Z_0-9]+)'), 'unknown')) ORDER BY d.start_time DESC) AS rn
      FROM cron.job_run_details d LEFT JOIN cron.job j ON j.jobid = d.jobid
      WHERE d.start_time >= v_30d AND d.start_time <= v_end
    ), stats AS (
      SELECT jobname, max(schedule) AS schedule, max(command) AS command,
        count(*) FILTER (WHERE start_time >= v_start AND start_time <= v_end AND status <> 'succeeded') AS failures_today,
        count(*) FILTER (WHERE start_time >= v_start AND start_time <= v_end) AS runs_today,
        count(*) FILTER (WHERE start_time >= v_prev_start AND start_time < v_start AND status <> 'succeeded') AS failures_prev,
        count(*) FILTER (WHERE start_time >= v_7d AND status <> 'succeeded') AS failures_7d,
        count(*) FILTER (WHERE status <> 'succeeded') AS failures_30d,
        count(*) AS runs_30d,
        max(start_time) FILTER (WHERE status = 'succeeded') AS last_success,
        max(start_time) FILTER (WHERE status <> 'succeeded') AS last_failure,
        (array_agg(return_message ORDER BY start_time DESC) FILTER (WHERE status <> 'succeeded'))[1] AS last_error,
        avg(EXTRACT(epoch FROM (end_time - start_time))) FILTER (WHERE end_time IS NOT NULL) AS avg_seconds
      FROM runs GROUP BY jobname
    ), consec AS (
      SELECT jobname, count(*) AS consecutive_failures FROM (
        SELECT r.jobname, r.rn, r.status,
               min(CASE WHEN r.status = 'succeeded' THEN r.rn END) OVER (PARTITION BY r.jobname) AS first_ok
        FROM runs r) t
      WHERE status <> 'succeeded' AND (first_ok IS NULL OR rn < first_ok)
      GROUP BY jobname
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'automation', s.jobname,
      'purpose', CASE
        WHEN s.command ILIKE '%net.http_post%' THEN 'Invokes an edge function on a schedule'
        WHEN s.command ILIKE '%delete%' THEN 'Scheduled data retention / cleanup'
        ELSE 'Scheduled database routine' END,
      'trigger', 'pg_cron scheduler',
      'schedule', s.schedule,
      'command', left(COALESCE(s.command,''), 400),
      'runs_today', s.runs_today, 'runs_30d', s.runs_30d,
      'failures_today', s.failures_today, 'failures_7d', s.failures_7d, 'failures_30d', s.failures_30d,
      'trend_yesterday', s.failures_today - s.failures_prev,
      'consecutive_failures', COALESCE(c.consecutive_failures,0),
      'last_success_at', s.last_success, 'last_failure_at', s.last_failure,
      'error_message', COALESCE(left(s.last_error, 900), 'not captured'),
      'avg_duration_seconds', round(COALESCE(s.avg_seconds,0)::numeric, 2),
      'dependencies', CASE WHEN s.command ILIKE '%net.http_post%' THEN 'pg_net, edge function runtime, downstream provider APIs' ELSE 'Postgres only' END,
      'downstream_affected', CASE
        WHEN s.jobname ILIKE '%report%' THEN 'Executive email reporting'
        WHEN s.jobname ILIKE '%sweep%' OR s.jobname ILIKE '%advance%' THEN 'Advance recovery and agent balances'
        WHEN s.jobname ILIKE '%wallet%' OR s.jobname ILIKE '%ledger%' OR s.jobname ILIKE '%drift%' THEN 'Wallet and ledger reconciliation'
        ELSE 'Scheduled maintenance only' END,
      'retry_attempts', 'pg_cron does not retry; next scheduled tick is the retry',
      'recovery_recommendation', CASE
        WHEN COALESCE(s.last_error,'') ILIKE '%timeout%' THEN 'Increase the statement timeout for this job or batch the workload into smaller chunks.'
        WHEN COALESCE(s.last_error,'') ILIKE '%permission%' THEN 'Repair the role grants used by the cron owner and re-run manually to confirm.'
        WHEN COALESCE(s.last_error,'') ILIKE '%does not exist%' THEN 'The referenced function or column was renamed - update the cron command to the current signature.'
        ELSE 'Run the job body manually with logging enabled, capture the exception, then patch and re-schedule.' END,
      'severity', CASE WHEN COALESCE(c.consecutive_failures,0) >= 5 THEN 'Critical'
                       WHEN s.failures_today >= 3 THEN 'High'
                       WHEN s.failures_today > 0 THEN 'Medium' ELSE 'Low' END,
      'status', CASE WHEN s.last_success IS NULL THEN 'Never succeeded in 30 days'
                     WHEN COALESCE(c.consecutive_failures,0) > 0 THEN 'Failing'
                     ELSE 'Recovered' END
    ) ORDER BY s.failures_today DESC, s.failures_7d DESC), '[]'::jsonb)
    INTO v_autos
    FROM stats s LEFT JOIN consec c ON c.jobname = s.jobname
    WHERE s.failures_7d > 0;
  EXCEPTION WHEN OTHERS THEN v_autos := '[]'::jsonb;
  END;

  -- ============ 3. SLOW QUERY DEEP DETAIL ============
  BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'statement', left(q.query, 1200),
      'calls', q.calls,
      'mean_ms', round(q.mean_exec_time::numeric,2),
      'max_ms', round(q.max_exec_time::numeric,2),
      'total_ms', round(q.total_exec_time::numeric,2),
      'rows_returned', q.rows,
      'rows_per_call', round((q.rows::numeric / GREATEST(q.calls,1)),1),
      'blocks_scanned', q.shared_blks_hit + q.shared_blks_read,
      'disk_reads', q.shared_blks_read,
      'cache_hit_pct', round((100.0 * q.shared_blks_hit / GREATEST(q.shared_blks_hit + q.shared_blks_read,1))::numeric,2),
      'temp_blocks', q.temp_blks_read + q.temp_blks_written,
      'cpu_ms_estimate', round((q.total_exec_time - COALESCE(q.shared_blk_read_time,0))::numeric,2),
      'memory_pressure', CASE WHEN (q.temp_blks_written) > 0 THEN 'Spilling to temp files - work_mem exceeded' ELSE 'Within work_mem' END,
      'plan_note', CASE
        WHEN q.shared_blks_read > q.shared_blks_hit THEN 'Read-heavy: plan is going to disk, likely a sequential scan on a large table.'
        WHEN (q.rows::numeric / GREATEST(q.calls,1)) > 5000 THEN 'Returns very large result sets per call - plan is materialising too many rows.'
        ELSE 'Cached plan; cost is dominated by call volume rather than a single bad scan.' END,
      'optimization_recommendation', CASE
        WHEN q.shared_blks_read > q.shared_blks_hit THEN 'Run EXPLAIN (ANALYZE, BUFFERS) and add a covering index on the filter and join columns.'
        WHEN (q.rows::numeric / GREATEST(q.calls,1)) > 5000 THEN 'Add pagination or aggregate server-side instead of returning full result sets.'
        WHEN q.calls > 100000 THEN 'Very high call volume - cache the result or batch the callers.'
        ELSE 'Review the statement for redundant joins and confirm statistics are fresh (ANALYZE).' END,
      'severity', CASE WHEN q.mean_exec_time > 2000 THEN 'Critical' WHEN q.mean_exec_time > 500 THEN 'High' WHEN q.mean_exec_time > 200 THEN 'Medium' ELSE 'Low' END,
      'owner', 'Backend / Database'
    ) ORDER BY q.total_exec_time DESC), '[]'::jsonb)
    INTO v_slow
    FROM (
      SELECT * FROM pg_stat_statements
      WHERE query NOT ILIKE '%pg_stat_statements%' AND query NOT ILIKE '%cron.job%'
      ORDER BY total_exec_time DESC LIMIT 10
    ) q;
  EXCEPTION WHEN OTHERS THEN v_slow := '[]'::jsonb;
  END;

  -- ============ 4. LOCK WAITS AND BLOCKING SESSIONS ============
  -- (attached to slow query payload consumer side)

  -- ============ 5. API / EDGE FUNCTION FAILURES ============
  WITH api AS (
    SELECT
      COALESCE(NULLIF(ctx->>'endpoint',''),
        CASE WHEN message ~* 'functions/v1/([a-z0-9-]+)'
             THEN (regexp_match(message,'functions/v1/([a-z0-9-]+)'))[1]
             ELSE NULL END) AS endpoint,
      COALESCE(NULLIF(ctx->>'method',''),'POST') AS method,
      COALESCE(NULLIF(ctx->>'status',''),
        CASE WHEN message ~ '\m(4\d\d|5\d\d)\M' THEN (regexp_match(message,'\m(4\d\d|5\d\d)\M'))[1] ELSE 'unknown' END) AS status_code,
      message, user_id, created_at
    FROM (SELECT COALESCE(context,'{}'::jsonb) AS ctx, message, user_id, created_at
          FROM client_error_reports WHERE created_at >= v_30d AND created_at <= v_end) s
    WHERE message ILIKE '%non-2xx%' OR message ILIKE '%edge function%' OR message ILIKE '%functions/v1%'
       OR message ILIKE '%failed to fetch%' OR message ILIKE '%networkerror%'
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'endpoint', COALESCE(endpoint,'unattributed client request'),
    'method', method,
    'status_code', status_code,
    'failure_reason', COALESCE((public.cto_classify_error(sample_msg))->>'root_cause','Unclassified'),
    'failed_today', failed_today,
    'failed_7d', failed_7d,
    'failed_30d', failed_30d,
    'trend_yesterday', failed_today - failed_prev,
    'affected_users', users_today,
    'error_percentage', 100.0,
    'first_seen', first_seen, 'last_seen', last_seen,
    'affected_clients', 'Web SPA clients reporting from the field',
    'remediation', COALESCE((public.cto_classify_error(sample_msg))->>'fix','Reproduce the call, log the upstream response body, and patch the failing branch.'),
    'severity', CASE WHEN failed_today >= 100 THEN 'Critical' WHEN failed_today >= 25 THEN 'High' WHEN failed_today > 0 THEN 'Medium' ELSE 'Low' END,
    'owner', 'Backend'
  ) ORDER BY failed_today DESC), '[]'::jsonb)
  INTO v_apis
  FROM (
    SELECT endpoint, method, status_code,
      count(*) FILTER (WHERE created_at >= v_start) AS failed_today,
      count(*) FILTER (WHERE created_at >= v_prev_start AND created_at < v_start) AS failed_prev,
      count(*) FILTER (WHERE created_at >= v_7d) AS failed_7d,
      count(*) AS failed_30d,
      count(DISTINCT user_id) FILTER (WHERE created_at >= v_start) AS users_today,
      min(created_at) AS first_seen, max(created_at) AS last_seen,
      (array_agg(message ORDER BY created_at DESC))[1] AS sample_msg
    FROM api GROUP BY endpoint, method, status_code
    ORDER BY 4 DESC LIMIT 15
  ) t;

  -- ============ 6. NOTIFICATION DELIVERY ============
  SELECT jsonb_build_object(
    'sent_today', count(*) FILTER (WHERE created_at >= v_start AND created_at <= v_end),
    'failed_today', count(*) FILTER (WHERE created_at >= v_start AND created_at <= v_end AND status <> 'sent'),
    'failed_prev', count(*) FILTER (WHERE created_at >= v_prev_start AND created_at < v_start AND status <> 'sent'),
    'failed_7d', count(*) FILTER (WHERE created_at >= v_7d AND status <> 'sent'),
    'failed_30d', count(*) FILTER (WHERE created_at >= v_30d AND status <> 'sent'),
    'by_template', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('template', template_name, 'failures', n, 'error', err) ORDER BY n DESC)
      FROM (
        SELECT COALESCE(template_name,'unknown') AS template_name, count(*) n,
               left(COALESCE((array_agg(error_message ORDER BY created_at DESC) FILTER (WHERE error_message IS NOT NULL))[1],'not captured'),300) AS err
        FROM email_send_log WHERE created_at >= v_7d AND status <> 'sent'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 10) x), '[]'::jsonb)
  ) INTO v_notif FROM email_send_log WHERE created_at >= v_30d;

  -- ============ 7. AUTHENTICATION FAILURES ============
  SELECT jsonb_build_object(
    'attempts_today', count(*) FILTER (WHERE created_at >= v_start AND created_at <= v_end),
    'failed_today', count(*) FILTER (WHERE created_at >= v_start AND created_at <= v_end AND status <> 'allowed'),
    'failed_prev', count(*) FILTER (WHERE created_at >= v_prev_start AND created_at < v_start AND status <> 'allowed'),
    'failed_7d', count(*) FILTER (WHERE created_at >= v_7d AND status <> 'allowed'),
    'failed_30d', count(*) FILTER (WHERE created_at >= v_30d AND status <> 'allowed'),
    'reasons', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('reason', reason, 'n', n, 'ips', ips) ORDER BY n DESC)
      FROM (SELECT COALESCE(reason,'unspecified') AS reason, count(*) n, count(DISTINCT ip) ips
            FROM signup_attempts WHERE created_at >= v_7d AND status <> 'allowed'
            GROUP BY 1 ORDER BY 2 DESC LIMIT 10) y), '[]'::jsonb)
  ) INTO v_authj FROM signup_attempts WHERE created_at >= v_30d;

  RETURN jsonb_build_object(
    'date', p_date,
    'generated_at', now(),
    'issues', v_issues,
    'automations', v_autos,
    'slow_queries', v_slow,
    'api_failures', v_apis,
    'notifications', v_notif,
    'auth', v_authj
  );
END;
$function$;
