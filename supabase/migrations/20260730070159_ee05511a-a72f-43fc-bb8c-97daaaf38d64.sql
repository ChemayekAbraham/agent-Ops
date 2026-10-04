
CREATE OR REPLACE FUNCTION public.get_cto_diagnostics(p_date date DEFAULT ((now() AT TIME ZONE 'Africa/Kampala'::text))::date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
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
        'automation', j.jobname,
        'schedule', j.schedule,
        'command', left(j.command, 220),
        'active', j.active,
        'failures_24h', count(*) FILTER (WHERE d.status <> 'succeeded'),
        'runs_24h', count(*),
        'last_failure_at', max(d.start_time) FILTER (WHERE d.status <> 'succeeded'),
        'last_success_at', (SELECT max(d2.end_time) FROM cron.job_run_details d2 WHERE d2.jobid = j.jobid AND d2.status='succeeded'),
        'exception', left(COALESCE((array_agg(d.return_message ORDER BY d.start_time DESC) FILTER (WHERE d.status <> 'succeeded'))[1],''), 600),
        'retry_status', CASE WHEN count(*) FILTER (WHERE d.status='succeeded') > 0 THEN 'Recovered on a later run in the window' ELSE 'No successful run in the last 24h' END,
        'recommended_fix', 'Run the job body manually against the same arguments, capture the exception above, and gate the failing step.'
      ) AS x
      FROM cron.job_run_details d
      JOIN cron.job j USING (jobid)
      WHERE d.start_time >= v_end - interval '24 hours'
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

  WITH m AS (
    SELECT
      (SELECT count(*) FROM pg_stat_activity)::numeric AS conns,
      (SELECT setting::numeric FROM pg_settings WHERE name='max_connections') AS max_conns,
      (SELECT round(100.0*blks_hit/NULLIF(blks_hit+blks_read,0),2) FROM pg_stat_database WHERE datname=current_database()) AS cache_hit,
      (SELECT deadlocks FROM pg_stat_database WHERE datname=current_database())::numeric AS deadlocks,
      (SELECT round(100.0*xact_rollback/NULLIF(xact_commit+xact_rollback,0),2) FROM pg_stat_database WHERE datname=current_database()) AS rollback_pct,
      pg_database_size(current_database())::numeric AS db_bytes,
      (SELECT count(*) FROM pg_locks WHERE NOT granted)::numeric AS waiting_locks
  )
  SELECT COALESCE(jsonb_agg(x),'[]'::jsonb) INTO v_infra FROM (
    SELECT jsonb_build_object('metric','Connection saturation','current', round(100.0*conns/NULLIF(max_conns,0),1)||'% ('||conns||'/'||max_conns||')','threshold','80%','status', CASE WHEN conns/NULLIF(max_conns,0) > 0.8 THEN 'Breached' ELSE 'OK' END,'root_cause','Client pool leaks or long-running transactions holding sessions open.','impact','New requests are refused once the pool is exhausted.','action','Reduce idle-in-transaction time and raise the database instance size if sustained above 80%.') AS x FROM m
    UNION ALL SELECT jsonb_build_object('metric','Buffer cache hit ratio','current', cache_hit||'%','threshold','>= 99%','status', CASE WHEN cache_hit < 99 THEN 'Breached' ELSE 'OK' END,'root_cause','Working set is larger than shared memory, so reads fall through to disk.','impact','Higher query latency across the app.','action','Add indexes to the sequential-scan tables listed above or increase the database instance memory.') FROM m
    UNION ALL SELECT jsonb_build_object('metric','Database size','current', pg_size_pretty(db_bytes::bigint),'threshold','Review at 80% of provisioned disk','status','Informational','root_cause','Log and event tables grow fastest.','impact','Disk exhaustion halts writes.','action','Keep the nightly retention crons healthy; expand disk before 80% utilisation.') FROM m
    UNION ALL SELECT jsonb_build_object('metric','Deadlocks since boot','current', deadlocks::text,'threshold','0 growth per day','status', CASE WHEN deadlocks > 0 THEN 'Watch' ELSE 'OK' END,'root_cause','Two transactions locking the same rows in opposite order.','impact','Failed writes surfaced to users as generic errors.','action','Order multi-row updates consistently inside the RPCs that touch wallets and ledger.') FROM m
    UNION ALL SELECT jsonb_build_object('metric','Transaction rollback rate','current', COALESCE(rollback_pct,0)||'%','threshold','< 2%','status', CASE WHEN COALESCE(rollback_pct,0) > 2 THEN 'Breached' ELSE 'OK' END,'root_cause','Constraint/trigger rejections or aborted client transactions.','impact','User actions silently fail and are retried.','action','Trace the rejecting triggers and return actionable messages to the client.') FROM m
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
$fn$;

GRANT EXECUTE ON FUNCTION public.get_cto_diagnostics(date) TO authenticated, service_role;
