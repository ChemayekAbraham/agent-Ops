-- Daily CTO Report + Board Technology Memo accuracy fixes, found while
-- verifying the 2026-09-15 daily report and week-ending-2026-09-15 board
-- memo PDFs against live production data.
--
-- Bug 1 — get_cto_diagnostics() "Authentication Diagnostics" section
-- (rendered as "Sign-in failure" rows in the CTO report) counted every
-- public.login_phase_events row with status <> 'success' as a sign-in
-- failure. Most non-signin phases (auth.enforceAccountAccess.end,
-- gate.account_frozen.check, gate.name_completion.check.end,
-- gate.phone_collection.check.end, auth.getSession.end, guard.resolved)
-- report their OWN success as status = 'ok', not 'success' — that
-- vocabulary is only used by phase = 'auth.signin.attempt'. As a result
-- ~26,500 routine, successful checkpoint events on 2026-09-15 alone were
-- mislabeled "Sign-in failure", producing a table that implied ~28,000
-- authentication failures in the same report whose own dashboard
-- (get_cto_daily_report, phase-scoped correctly) reported 58 failures and
-- 85.5% success. Fix: treat 'ok' as a non-failure status alongside
-- 'success' in this breakdown, same as every other phase already does.
--
-- Bug 2 — get_cto_issue_intelligence() classified slow-query issues from
-- pg_stat_statements (a lifetime-cumulative counter since the last stats
-- reset, not a same-day figure) as 'Critical' whenever mean_exec_time
-- exceeded 2000ms. daily-cto-report/index.ts already assumes this was
-- capped at Medium/P3 (see its comment at the slow-query issue block) and
-- renders an explicit "chronic, not a same-day incident" ETA — but because
-- the RPC still emitted 'Critical', and the edge function's "Today" action
-- bucket is `eta === 'Today' || severity === 'Critical'`, every chronic
-- 30-200+ day old query landed in "CTO Engineering Action Plan: Today" as
-- a same-day P1, contradicting the report's own "cumulative since last
-- stats reset, no daily delta" framing one column over. Fix: cap severity
-- at Medium/Low and emit explicit priority/blocking_production/
-- resolution_eta fields so the edge function no longer has to infer them.
--
-- Bug 3 (this repo's own gap) — 20260912093000_schedule_daily_cto_snapshot_
-- capture.sql scheduled 'capture-daily-cto-snapshot' to fix exactly this
-- class of gap, but the migration never actually applied in production
-- (supabase/migrations does not reliably reflect live state — see
-- mem/architecture). public.db_stat_snapshots has had no new row since
-- 2026-09-02, which is why "Unavailable" rollback rate / commits /
-- deadlocks have been showing for two weeks. Re-applying it here.

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

  -- Bug 1 fix: 'ok' is the success status for non-signin phases
  -- (auth.enforceAccountAccess.end, gate.*.check(.end), auth.getSession.end,
  -- guard.resolved). Only phase = 'auth.signin.attempt' uses 'success'.
  -- Excluding both keeps genuine sign-in failures (error, rate_limited,
  -- denied, frozen, fraud_blocked, ...) while dropping routine "ok"
  -- checkpoint telemetry that isn't a sign-in event at all.
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
        WHERE created_at >= v_start AND created_at <= v_end AND status NOT IN ('success','ok')
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

-- Bug 2 fix: cap slow-query severity at Medium/Low (pg_stat_statements is
-- lifetime-cumulative, never a same-day figure) and emit explicit
-- priority/blocking_production/resolution_eta so the edge function reads
-- the RPC's classification instead of re-deriving urgency from severity.
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
      'severity', CASE WHEN q.mean_exec_time > 500 THEN 'Medium' ELSE 'Low' END,
      'priority', 'P3',
      'blocking_production', false,
      'resolution_eta', 'Ongoing - chronic performance debt, not a same-day incident',
      'owner', 'Backend / Database',
      'stats_since', q.stats_since
    ) ORDER BY q.total_exec_time DESC), '[]'::jsonb)
    INTO v_slow
    FROM (
      SELECT * FROM pg_stat_statements
      WHERE query NOT ILIKE '%pg_stat_statements%' AND query NOT ILIKE '%cron.job%'
      ORDER BY total_exec_time DESC LIMIT 10
    ) q;
  EXCEPTION WHEN OTHERS THEN v_slow := '[]'::jsonb;
  END;

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

  SELECT jsonb_build_object(
    'sent_today', count(*) FILTER (WHERE created_at >= v_start AND created_at <= v_end),
    'failed_today', count(*) FILTER (WHERE created_at >= v_start AND created_at <= v_end AND status NOT IN ('sent','pending')),
    'failed_prev', count(*) FILTER (WHERE created_at >= v_prev_start AND created_at < v_start AND status NOT IN ('sent','pending')),
    'failed_7d', count(*) FILTER (WHERE created_at >= v_7d AND status NOT IN ('sent','pending')),
    'failed_30d', count(*) FILTER (WHERE created_at >= v_30d AND status NOT IN ('sent','pending')),
    'by_template', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('template', template_name, 'failures', n, 'error', err) ORDER BY n DESC)
      FROM (
        SELECT COALESCE(template_name,'unknown') AS template_name, count(*) n,
               left(COALESCE((array_agg(error_message ORDER BY created_at DESC) FILTER (WHERE error_message IS NOT NULL))[1],'not captured'),300) AS err
        FROM email_send_log WHERE created_at >= v_7d AND status NOT IN ('sent','pending')
        GROUP BY 1 ORDER BY 2 DESC LIMIT 10) x), '[]'::jsonb)
  ) INTO v_notif FROM email_send_log WHERE created_at >= v_30d;

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

-- Bug 3 fix: re-apply the snapshot-capture schedule. It exists in this
-- repo's history (20260912093000) but was never actually live — db_stat_
-- snapshots has had no row since 2026-09-02. Idempotent to re-run.
SELECT cron.unschedule('capture-daily-cto-snapshot')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'capture-daily-cto-snapshot');

SELECT cron.schedule(
  'capture-daily-cto-snapshot',
  '55 20 * * *',
  $$SELECT public.get_cto_daily_report();$$
);
