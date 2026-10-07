-- Board Technology Memo data source (doc 201).
--
-- The weekly board memo used to be assembled in the edge function from the
-- daily CTO report payload, summed seven times. That route produced several
-- wrong board figures (see docs/HANDOVER/201-board-tech-memo-rebuild-2026-10-07.md):
--   * rollback % silently skipped a counter-reset day and reported 6 days as 7
--   * "delivery-report sweep has never marked a message delivered" was false
--   * sign-in "platform failure 0.00%" ignored slow rejections and start-up timeouts
-- This RPC computes every board figure directly from the source tables for a
-- 7-day window ending p_date (EAT), and says explicitly which days could not be
-- measured instead of dropping them.
--
-- Read-only. SECURITY DEFINER with the same role gate as get_cto_daily_report.

CREATE OR REPLACE FUNCTION public.get_board_tech_memo(
  p_date date DEFAULT ((now() AT TIME ZONE 'Africa/Kampala'))::date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_today   date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_from    timestamptz := ((p_date - 6)::text || ' 00:00:00+03')::timestamptz;
  v_to      timestamptz := LEAST(now(), ((p_date + 1)::text || ' 00:00:00+03')::timestamptz);
  v_30d     timestamptz;
  v_partial boolean;
  v_live_commit bigint;
  v_live_rollback bigint;
  v_live_deadlocks bigint;
  v_pm_start timestamptz := pg_postmaster_start_time();
  v_sms jsonb; v_sms_days jsonb; v_sms_streams jsonb; v_email jsonb;
  v_signin jsonb; v_otp jsonb; v_otp_login jsonb; v_signups jsonb;
  v_errors jsonb; v_db jsonb; v_jobs jsonb; v_sec jsonb; v_backups jsonb;
  v_slow jsonb;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'manager')
    OR auth.role() = 'service_role' OR auth.uid() IS NULL
  ) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  v_30d := v_to - interval '30 days';
  v_partial := (p_date >= v_today);

  -- ---------------------------------------------------------------- SMS
  -- One row per logical message: drop intermediate retry attempts.
  CREATE TEMP TABLE IF NOT EXISTS _bm_sms (LIKE public.sms_delivery_log) ON COMMIT DROP;
  TRUNCATE _bm_sms;
  INSERT INTO _bm_sms
  SELECT * FROM public.sms_delivery_log
  WHERE created_at >= v_from AND created_at < v_to
    AND NOT (provider_response ? 'total_attempts'
             AND (provider_response->>'attempt_sequence')::int < (provider_response->>'total_attempts')::int);

  WITH c AS (
    SELECT s.*,
      CASE
        WHEN s.status IN ('sent','accepted','delivered') THEN 'reached'
        WHEN s.status IN ('queued','pending') THEN 'queued'
        WHEN s.status = 'failed' THEN
          CASE
            WHEN coalesce(s.error,'') ~* 'authorization with key failed' THEN 'backup_key'
            WHEN coalesce(s.error,'') ~* '429|rate_limit|rate limit' THEN 'rate'
            WHEN coalesce(s.error,'') ~* '402|insufficient|credit' THEN 'credit'
            WHEN coalesce(s.error,'') ~* 'invalid|422|no valid|non-ugandan|no phone' THEN 'invalid'
            WHEN coalesce(s.error,'') ~* 'accepted but did not confirm' THEN 'unconfirmed'
            ELSE 'other'
          END
        ELSE 'other'
      END AS outcome
    FROM _bm_sms s
  )
  SELECT jsonb_build_object(
    'total', count(*),
    'phones', count(DISTINCT recipient_phone),
    'reached', count(*) FILTER (WHERE outcome = 'reached'),
    'confirmed', count(*) FILTER (WHERE status = 'delivered'),
    'confirmed_latest', max(created_at) FILTER (WHERE status = 'delivered'),
    'queued', count(*) FILTER (WHERE outcome = 'queued'),
    'failed', count(*) FILTER (WHERE status = 'failed'),
    'credit', count(*) FILTER (WHERE outcome = 'credit'),
    'rate', count(*) FILTER (WHERE outcome = 'rate'),
    'backup_key', count(*) FILTER (WHERE outcome = 'backup_key'),
    'invalid', count(*) FILTER (WHERE outcome = 'invalid'),
    'unconfirmed', count(*) FILTER (WHERE outcome = 'unconfirmed'),
    'other', count(*) FILTER (WHERE outcome = 'other'),
    'otp_total', count(*) FILTER (WHERE source IN ('sms-otp','password-reset-sms')),
    'otp_failed', count(*) FILTER (WHERE source IN ('sms-otp','password-reset-sms') AND status = 'failed'),
    'credit_by_day', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('d', d, 'n', n) ORDER BY d)
      FROM (SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date AS d, count(*) AS n
            FROM c c2 WHERE c2.outcome = 'credit' GROUP BY 1) x), '[]'::jsonb),
    'rate_by_day', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('d', d, 'n', n) ORDER BY d)
      FROM (SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date AS d, count(*) AS n
            FROM c c2 WHERE c2.outcome = 'rate' GROUP BY 1) x), '[]'::jsonb)
  ) INTO v_sms FROM c;

  -- Handset confirmation can only be judged against the 30-day provider mix
  -- (a window this short can legitimately hold zero confirmations).
  v_sms := v_sms || jsonb_build_object(
    'confirmed_30d', (SELECT count(*) FROM public.sms_delivery_log WHERE created_at >= v_30d AND created_at < v_to AND status = 'delivered'),
    'total_30d', (SELECT count(*) FROM public.sms_delivery_log WHERE created_at >= v_30d AND created_at < v_to),
    'confirmed_latest_30d', (SELECT max(created_at) FROM public.sms_delivery_log WHERE created_at >= v_30d AND created_at < v_to AND status = 'delivered')
  );

  SELECT COALESCE(jsonb_agg(jsonb_build_object('d', d, 'total', t, 'reached', r, 'failed', f, 'queued', q) ORDER BY d), '[]'::jsonb)
  INTO v_sms_days
  FROM (
    SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date AS d, count(*) t,
           count(*) FILTER (WHERE status IN ('sent','accepted','delivered')) r,
           count(*) FILTER (WHERE status = 'failed') f,
           count(*) FILTER (WHERE status IN ('queued','pending')) q
    FROM _bm_sms GROUP BY 1
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('source', source, 'total', t, 'failed', f) ORDER BY f DESC), '[]'::jsonb)
  INTO v_sms_streams
  FROM (
    SELECT source, count(*) t, count(*) FILTER (WHERE status = 'failed') f
    FROM _bm_sms GROUP BY 1 HAVING count(*) FILTER (WHERE status = 'failed') > 0
    ORDER BY f DESC LIMIT 5
  ) x;

  -- -------------------------------------------------------------- E-mail
  WITH latest AS (
    SELECT DISTINCT ON (message_id) message_id, status, error_message, created_at
    FROM public.email_send_log
    WHERE created_at >= v_from AND created_at < v_to
    ORDER BY message_id, created_at DESC
  ), l30 AS (
    SELECT DISTINCT ON (message_id) message_id, status
    FROM public.email_send_log
    WHERE created_at >= v_30d AND created_at < v_to
    ORDER BY message_id, created_at DESC
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM latest),
    'sent', (SELECT count(*) FROM latest WHERE status = 'sent'),
    'suppressed', (SELECT count(*) FROM latest WHERE status = 'suppressed'),
    'failed', (SELECT count(*) FROM latest WHERE status IN ('failed','dlq')),
    'pending', (SELECT count(*) FROM latest WHERE status IN ('pending','rate_limited')),
    'total_30d', (SELECT count(*) FROM l30),
    'sent_30d', (SELECT count(*) FROM l30 WHERE status = 'sent')
  ) INTO v_email;

  -- ------------------------------------------------------------- Sign-in
  WITH att AS (
    SELECT session_trace_id, status, user_id,
           (detail->>'accountExists') AS acct,
           CASE WHEN (detail->>'totalMs') ~ '^[0-9]+$' THEN (detail->>'totalMs')::int END AS ms
    FROM public.login_phase_events
    WHERE phase = 'auth.signin.attempt' AND created_at >= v_from AND created_at < v_to
  ), cls AS (
    SELECT *,
      CASE
        WHEN status = 'success' THEN 'ok'
        WHEN acct = 'false' THEN 'no_account'
        WHEN status = 'rate_limited' THEN 'platform'
        WHEN status = 'error' AND acct = 'true' AND coalesce(ms, 0) < 5000 THEN 'fast_reject'
        WHEN status = 'error' AND acct = 'true' THEN 'slow_reject'
        ELSE 'platform'
      END AS k
    FROM att
  ), tried AS (SELECT DISTINCT session_trace_id FROM att WHERE session_trace_id IS NOT NULL),
     got_in AS (SELECT DISTINCT session_trace_id FROM att WHERE session_trace_id IS NOT NULL AND status = 'success')
  SELECT jsonb_build_object(
    'attempts', (SELECT count(*) FROM cls),
    'ok', (SELECT count(*) FROM cls WHERE k = 'ok'),
    'fast_reject', (SELECT count(*) FROM cls WHERE k = 'fast_reject'),
    'slow_reject', (SELECT count(*) FROM cls WHERE k = 'slow_reject'),
    'no_account', (SELECT count(*) FROM cls WHERE k = 'no_account'),
    'platform', (SELECT count(*) FROM cls WHERE k = 'platform'),
    'people_tried', (SELECT count(*) FROM tried),
    'people_in', (SELECT count(*) FROM got_in)
  ) INTO v_signin;

  v_signin := v_signin || (
    SELECT jsonb_build_object(
      'startup_timeouts', count(*),
      'startup_timeout_users', count(DISTINCT user_id),
      'startup_timeout_sessions', count(DISTINCT session_trace_id)
    ) FROM public.login_phase_events
    WHERE phase = 'auth.init.timeout_forced' AND created_at >= v_from AND created_at < v_to
  );
  v_signin := v_signin || jsonb_build_object('startup_timeouts_by_day', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('d', d, 'n', n) ORDER BY d)
    FROM (SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date d, count(*) n
          FROM public.login_phase_events
          WHERE phase = 'auth.init.timeout_forced' AND created_at >= v_from AND created_at < v_to
          GROUP BY 1) x), '[]'::jsonb));

  -- Access-denied loop: group by user first. A handful of accounts bouncing
  -- off a guard is not thousands of separate failures.
  v_signin := v_signin || (
    WITH d AS (
      SELECT user_id, count(*) n FROM public.login_phase_events
      WHERE phase = 'guard.resolved' AND status = 'denied' AND created_at >= v_from AND created_at < v_to
      GROUP BY 1
    )
    SELECT jsonb_build_object(
      'denied_users', (SELECT count(*) FROM d),
      'denied_events', (SELECT COALESCE(sum(n),0) FROM d),
      'denied_top_user_events', (SELECT COALESCE(max(n),0) FROM d)
    )
  );
  v_signin := v_signin || (
    SELECT jsonb_build_object('frozen_users', count(DISTINCT user_id), 'frozen_events', count(*))
    FROM public.login_phase_events
    WHERE phase = 'gate.account_frozen.check' AND status = 'frozen'
      AND created_at >= v_from AND created_at < v_to
  );

  -- ----------------------------------------------------------------- OTP
  SELECT COALESCE(jsonb_agg(jsonb_build_object('category', category, 'sent', s, 'verified', v, 'failed', f) ORDER BY category), '[]'::jsonb)
  INTO v_otp
  FROM (
    SELECT category,
           count(*) FILTER (WHERE event_type = 'sent') s,
           count(*) FILTER (WHERE event_type = 'verify_success') v,
           count(*) FILTER (WHERE event_type = 'verify_failed') f
    FROM public.otp_usage_events
    WHERE created_at >= v_from AND created_at < v_to
    GROUP BY 1
  ) x;

  SELECT jsonb_build_object(
    'total', count(*),
    'success', count(*) FILTER (WHERE outcome = 'success'),
    'failed', count(*) FILTER (WHERE outcome = 'failed'),
    'no_account', count(*) FILTER (WHERE outcome = 'no_account'),
    'error', count(*) FILTER (WHERE outcome = 'error')
  ) INTO v_otp_login
  FROM public.otp_login_audit WHERE created_at >= v_from AND created_at < v_to;

  -- ------------------------------------------------------------- Sign-ups
  SELECT jsonb_build_object(
    'created', (SELECT count(*) FROM public.profiles WHERE created_at >= v_from AND created_at < v_to),
    'by_day', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('d', d, 'n', n) ORDER BY d)
      FROM (SELECT (created_at AT TIME ZONE 'Africa/Kampala')::date d, count(*) n
            FROM public.profiles WHERE created_at >= v_from AND created_at < v_to GROUP BY 1) x), '[]'::jsonb),
    'opened_by_staff', (SELECT count(*) FROM public.signup_attempts
                        WHERE created_at >= v_from AND created_at < v_to AND status = 'allowed'
                          AND actor_user_id IS NOT NULL AND actor_user_id IS DISTINCT FROM user_id),
    'blocked', (SELECT count(*) FROM public.signup_attempts
                WHERE created_at >= v_from AND created_at < v_to AND status NOT IN ('allowed','abandoned')),
    'blocked_actors', (SELECT count(DISTINCT actor_user_id) FROM public.signup_attempts
                WHERE created_at >= v_from AND created_at < v_to AND status NOT IN ('allowed','abandoned')),
    'blocked_ips', (SELECT count(DISTINCT ip) FROM public.signup_attempts
                WHERE created_at >= v_from AND created_at < v_to AND status NOT IN ('allowed','abandoned'))
  ) INTO v_signups;

  -- ----------------------------------------------------------- App errors
  WITH e AS (
    SELECT user_id, message FROM public.client_error_reports
    WHERE created_at >= v_from AND created_at < v_to
  ), active AS (
    SELECT user_id FROM public.login_phase_events WHERE created_at >= v_from AND created_at < v_to AND user_id IS NOT NULL
    UNION SELECT user_id FROM e WHERE user_id IS NOT NULL
    UNION SELECT id FROM public.profiles WHERE last_active_at >= v_from AND last_active_at < v_to
  )
  SELECT jsonb_build_object(
    'errors', (SELECT count(*) FROM e),
    'affected_users', (SELECT count(DISTINCT user_id) FROM e),
    'active_users', (SELECT count(*) FROM active),
    'offline_storage', (SELECT count(*) FROM e WHERE message ILIKE '%IDBDatabase%' OR message ILIKE '%indexeddb%'),
    'map_crash', (SELECT count(*) FROM e WHERE message ILIKE '%M_ID%'),
    'top_messages', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('message', m, 'n', n) ORDER BY n DESC)
      FROM (SELECT left(coalesce(message,'unknown'),100) m, count(*) n FROM e GROUP BY 1 ORDER BY 2 DESC LIMIT 5) x), '[]'::jsonb),
    'top_routes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('route', r, 'n', n) ORDER BY n DESC)
      FROM (SELECT coalesce(route,'unknown') r, count(*) n FROM public.client_error_reports
            WHERE created_at >= v_from AND created_at < v_to GROUP BY 1 ORDER BY 2 DESC LIMIT 5) x), '[]'::jsonb)
  ) INTO v_errors FROM (SELECT 1) one;

  -- ------------------------------------------------------ Database / uptime
  -- Per-day rollback deltas from db_stat_snapshots (taken ~23:55 EAT). A day is
  -- measurable only if the previous day's snapshot exists AND the counters did
  -- not go backwards (a restart resets them). Unmeasurable days are reported as
  -- such, never silently dropped.
  SELECT xact_commit, xact_rollback, deadlocks INTO v_live_commit, v_live_rollback, v_live_deadlocks
  FROM pg_stat_database WHERE datname = current_database();

  WITH days AS (
    SELECT g::date AS d FROM generate_series(p_date - 6, p_date, interval '1 day') g
  ), snap AS (
    SELECT d.d,
      CASE WHEN d.d = v_today THEN v_live_commit   ELSE s.xact_commit   END AS c,
      CASE WHEN d.d = v_today THEN v_live_rollback ELSE s.xact_rollback END AS r,
      CASE WHEN d.d = v_today THEN v_live_deadlocks ELSE s.deadlocks    END AS dl,
      p.xact_commit AS pc, p.xact_rollback AS pr, p.deadlocks AS pdl
    FROM days d
    LEFT JOIN public.db_stat_snapshots s ON s.day = d.d
    LEFT JOIN public.db_stat_snapshots p ON p.day = d.d - 1
  ), calc AS (
    SELECT d,
      (c IS NOT NULL AND pc IS NOT NULL AND c >= pc AND r >= pr) AS ok,
      (c IS NOT NULL AND pc IS NOT NULL AND (c < pc OR r < pr)) AS reset,
      c - pc AS dc, r - pr AS dr, GREATEST(dl - pdl, 0) AS ddl
    FROM snap
  )
  SELECT jsonb_build_object(
    'days', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'd', d, 'ok', ok, 'reset', reset,
        'commits', CASE WHEN ok THEN dc END, 'rollbacks', CASE WHEN ok THEN dr END,
        'rate', CASE WHEN ok THEN round(100.0 * dr / NULLIF(dc + dr, 0), 1) END,
        'deadlocks', CASE WHEN ok THEN ddl END) ORDER BY d) FROM calc), '[]'::jsonb),
    'measured_days', (SELECT count(*) FROM calc WHERE ok),
    'commits', (SELECT COALESCE(sum(dc),0) FROM calc WHERE ok),
    'rollbacks', (SELECT COALESCE(sum(dr),0) FROM calc WHERE ok),
    'deadlocks', (SELECT COALESCE(sum(ddl),0) FROM calc WHERE ok),
    'postmaster_start', v_pm_start,
    'restarted_in_window', (v_pm_start >= v_from AND v_pm_start < v_to),
    'uptime_hours', round((EXTRACT(epoch FROM (now() - v_pm_start)) / 3600.0)::numeric, 1),
    'lifetime_rollback_pct', round(100.0 * v_live_rollback / NULLIF(v_live_commit + v_live_rollback, 0), 1),
    'cache_hit_pct', (SELECT round(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 2) FROM pg_stat_database WHERE datname = current_database()),
    'connections', (SELECT count(*) FROM pg_stat_activity),
    'max_connections', (SELECT setting::int FROM pg_settings WHERE name = 'max_connections')
  ) INTO v_db;

  BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('name', fn, 'mean_s', round(mean_ms / 1000.0, 0), 'calls', calls) ORDER BY mean_ms DESC), '[]'::jsonb)
    INTO v_slow
    FROM (
      SELECT substring(query from 'public\.([a-z_0-9]+)\(') AS fn, mean_exec_time AS mean_ms, calls
      FROM extensions.pg_stat_statements
      WHERE query ILIKE 'select public.%' AND calls > 20 AND mean_exec_time > 5000
      ORDER BY mean_exec_time DESC LIMIT 5
    ) x WHERE fn IS NOT NULL;
  EXCEPTION WHEN OTHERS THEN
    v_slow := '[]'::jsonb;
  END;

  -- ----------------------------------------------------- Jobs and security
  SELECT jsonb_build_object(
    'scheduled', (SELECT count(*) FROM cron.job),
    'runs', (SELECT count(*) FROM public.cto_cron_run_details WHERE start_time >= v_from AND start_time < v_to),
    'failed', (SELECT count(*) FROM public.cto_cron_run_details WHERE start_time >= v_from AND start_time < v_to AND status <> 'succeeded'),
    'failed_24h', (SELECT count(*) FROM public.cto_cron_run_details WHERE start_time >= v_to - interval '24 hours' AND start_time < v_to AND status <> 'succeeded'),
    'failing', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('job', jobname, 'n', n, 'error', last_error) ORDER BY n DESC)
      FROM (
        SELECT COALESCE(j.jobname, '(unscheduled) ' || COALESCE(substring(d.command from 'public\.([a-zA-Z_0-9]+)'), 'unknown')) AS jobname,
               count(*) n, max(left(COALESCE(d.return_message,''), 140)) AS last_error
        FROM public.cto_cron_run_details d LEFT JOIN cron.job j USING (jobid)
        WHERE d.start_time >= v_from AND d.start_time < v_to AND d.status <> 'succeeded'
        GROUP BY j.jobid, j.jobname, d.command ORDER BY n DESC LIMIT 5
      ) f), '[]'::jsonb)
  ) INTO v_jobs;

  SELECT jsonb_build_object(
    'rls_tables', (SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relrowsecurity),
    'public_tables', (SELECT count(*) FROM pg_tables WHERE schemaname = 'public'),
    'fraud_blocks_active', (SELECT count(*) FROM public.fraud_identity_blocks WHERE status = 'active'),
    'privileged_accounts', (SELECT count(DISTINCT user_id) FROM public.user_roles
                            WHERE role IN ('super_admin','manager','cto','ceo','cfo','coo','access_admin'))
  ) INTO v_sec;

  SELECT jsonb_build_object(
    'runs', count(*),
    'failures', count(*) FILTER (WHERE status <> 'success'),
    'latest', max(created_at) FILTER (WHERE status = 'success'),
    'full', count(*) FILTER (WHERE backup_kind IS DISTINCT FROM 'ledger' AND status = 'success')
  ) INTO v_backups
  FROM public.backup_runs WHERE created_at >= v_from AND created_at < v_to;

  RETURN jsonb_build_object(
    'closing_date', p_date,
    'window_from', v_from,
    'window_to', v_to,
    'partial_day', v_partial,
    'generated_at', now(),
    'sms', v_sms,
    'sms_days', v_sms_days,
    'sms_streams', v_sms_streams,
    'email', v_email,
    'signin', v_signin,
    'otp', v_otp,
    'otp_login', v_otp_login,
    'signups', v_signups,
    'errors', v_errors,
    'db', v_db,
    'slow_jobs', v_slow,
    'jobs', v_jobs,
    'security', v_sec,
    'backups', v_backups
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_board_tech_memo(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_board_tech_memo(date) TO authenticated, service_role;
