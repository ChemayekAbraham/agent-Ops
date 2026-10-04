CREATE OR REPLACE FUNCTION public.get_cto_issue_intelligence(p_date date DEFAULT (now() AT TIME ZONE 'Africa/Kampala')::date - 1)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
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
  BEGIN
    WITH runs AS (
      SELECT j.jobname, j.schedule, j.command, d.status, d.return_message, d.start_time, d.end_time,
             row_number() OVER (PARTITION BY j.jobname ORDER BY d.start_time DESC) AS rn
      FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
      WHERE d.start_time >= v_30d
    ), stats AS (
      SELECT jobname, max(schedule) AS schedule, max(command) AS command,
        count(*) FILTER (WHERE start_time >= v_start AND status <> 'succeeded') AS failures_today,
        count(*) FILTER (WHERE start_time >= v_start) AS runs_today,
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
$fn$;

GRANT EXECUTE ON FUNCTION public.get_cto_issue_intelligence(date) TO authenticated, service_role;