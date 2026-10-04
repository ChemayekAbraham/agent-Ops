
CREATE OR REPLACE FUNCTION public.get_cto_daily_addendum(p_date date DEFAULT (now() AT TIME ZONE 'Africa/Kampala')::date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, cron
AS $fn$
DECLARE
  v_start timestamptz := (p_date::timestamp AT TIME ZONE 'Africa/Kampala');
  v_end   timestamptz := ((p_date + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_out   jsonb;
BEGIN
  WITH runs AS (
    SELECT r.jobid, j.jobname, j.schedule, j.command, r.status, r.return_message, r.start_time, r.end_time
    FROM cron.job_run_details r
    JOIN cron.job j ON j.jobid = r.jobid
    WHERE r.start_time >= v_start AND r.start_time < v_end
  ),
  jobagg AS (
    SELECT
      jobname, schedule, min(command) AS command,
      count(*) AS runs_today,
      count(*) FILTER (WHERE status = 'succeeded') AS success_today,
      count(*) FILTER (WHERE status <> 'succeeded') AS failures_today,
      max(start_time) FILTER (WHERE status = 'succeeded') AS last_success_today,
      max(start_time) FILTER (WHERE status <> 'succeeded') AS last_failure_today,
      min(start_time) FILTER (WHERE status <> 'succeeded') AS first_failure_today,
      (array_agg(return_message ORDER BY start_time DESC) FILTER (WHERE status <> 'succeeded'))[1] AS last_error,
      round(avg(EXTRACT(EPOCH FROM (end_time - start_time)) * 1000)::numeric, 0) AS avg_ms
    FROM runs GROUP BY jobname, schedule
  ),
  failed_jobs AS (
    SELECT
      jobname, schedule, runs_today, success_today, failures_today,
      CASE
        WHEN command ~* 'functions/v1/[a-z0-9_-]+'
          THEN 'Invokes the edge function "' || substring(command from 'functions/v1/([a-z0-9_-]+)') || '" on the schedule above.'
        WHEN command ~* 'select\s+(public\.)?([a-z0-9_]+)\s*\('
          THEN 'Runs the database routine "' || substring(command from '(?i)select\s+(?:public\.)?([a-z0-9_]+)\s*\(') || '".'
        WHEN command ~* '^\s*(delete|update|insert)'
          THEN 'Runs a scheduled data maintenance statement (' || lower(split_part(btrim(command), ' ', 1)) || ').'
        ELSE 'Scheduled maintenance task.'
      END AS what_it_does,
      CASE
        WHEN failures_today > 0 AND success_today = 0 THEN 'Broken all day - never succeeded today'
        WHEN failures_today > 0 THEN 'Intermittent - some runs succeeded'
        ELSE 'Healthy'
      END AS today_status,
      to_char(first_failure_today AT TIME ZONE 'Africa/Kampala', 'HH24:MI') AS first_failure_eat,
      to_char(last_failure_today AT TIME ZONE 'Africa/Kampala', 'HH24:MI') AS last_failure_eat,
      COALESCE(to_char(last_success_today AT TIME ZONE 'Africa/Kampala', 'HH24:MI'), 'none today') AS last_success_eat,
      regexp_replace(COALESCE(last_error, 'not captured'), '\s+', ' ', 'g') AS last_error,
      avg_ms,
      CASE
        WHEN last_error ILIKE '%does not exist%' THEN 'A referenced table, view, column or function was renamed or dropped. Update the job body to the current schema.'
        WHEN last_error ILIKE '%statement timeout%' OR last_error ILIKE '%canceling statement%' THEN 'The workload exceeds the statement timeout. Batch the job or raise the timeout for this job only.'
        WHEN last_error ILIKE '%permission denied%' OR last_error ILIKE '%must go through%' OR last_error ILIKE '%blocked%' THEN 'The job is writing through a path guarded by a trigger or policy. Route it through the approved function.'
        WHEN last_error ILIKE '%deadlock%' THEN 'Lock contention with concurrent writers. Reorder writes or reduce the batch size.'
        WHEN last_error ILIKE '%null value%' OR last_error ILIKE '%violates%' THEN 'A constraint rejected the write. Fix the source data or relax the constraint deliberately.'
        WHEN failures_today > 0 THEN 'Run the job body manually with logging on, capture the exception, patch and re-schedule.'
        ELSE ''
      END AS how_to_fix
    FROM jobagg
    WHERE failures_today > 0
    ORDER BY failures_today DESC
    LIMIT 25
  ),
  errs AS (
    SELECT
      btrim(regexp_replace(COALESCE(message,'Unlabelled error'), '\s+', ' ', 'g')) AS msg,
      user_id, route, role,
      CASE
        WHEN user_agent ILIKE '%Chrome%' AND user_agent NOT ILIKE '%Edg%' THEN 'Chrome'
        WHEN user_agent ILIKE '%Safari%' AND user_agent NOT ILIKE '%Chrome%' THEN 'Safari'
        WHEN user_agent ILIKE '%Firefox%' THEN 'Firefox'
        WHEN user_agent ILIKE '%Edg%' THEN 'Edge'
        ELSE 'Other'
      END AS browser,
      CASE WHEN user_agent ILIKE '%Android%' THEN 'Android'
           WHEN user_agent ILIKE '%iPhone%' OR user_agent ILIKE '%iPad%' THEN 'iOS'
           ELSE 'Desktop' END AS device,
      created_at
    FROM client_error_reports
    WHERE created_at >= v_start AND created_at < v_end
  ),
  errsig AS (
    SELECT
      left(msg, 160) AS signature,
      count(*) AS occurrences,
      count(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) AS users,
      (SELECT e2.route FROM errs e2 WHERE left(e2.msg,160) = left(e.msg,160) AND e2.route IS NOT NULL GROUP BY e2.route ORDER BY count(*) DESC LIMIT 1) AS top_route,
      (SELECT e2.browser FROM errs e2 WHERE left(e2.msg,160) = left(e.msg,160) GROUP BY e2.browser ORDER BY count(*) DESC LIMIT 1) AS top_browser,
      (SELECT e2.device FROM errs e2 WHERE left(e2.msg,160) = left(e.msg,160) GROUP BY e2.device ORDER BY count(*) DESC LIMIT 1) AS top_device,
      (SELECT e2.role FROM errs e2 WHERE left(e2.msg,160) = left(e.msg,160) AND e2.role IS NOT NULL GROUP BY e2.role ORDER BY count(*) DESC LIMIT 1) AS top_role,
      to_char(min(created_at) AT TIME ZONE 'Africa/Kampala', 'HH24:MI') AS first_seen_eat,
      to_char(max(created_at) AT TIME ZONE 'Africa/Kampala', 'HH24:MI') AS last_seen_eat
    FROM errs e
    GROUP BY left(msg, 160)
  ),
  user_errors AS (
    SELECT
      signature, occurrences, users, COALESCE(top_route,'unknown') AS top_route,
      top_browser, top_device, COALESCE(top_role,'unknown') AS top_role,
      first_seen_eat, last_seen_eat,
      CASE
        WHEN signature ILIKE '%Failed to fetch%' OR signature ILIKE '%NetworkError%' OR signature ILIKE '%Load failed%'
          THEN 'The screen could not reach the backend, so the user saw a blank panel or a spinner that never stopped.'
        WHEN signature ILIKE '%dynamically imported module%' OR signature ILIKE '%Importing a module script failed%' OR signature ILIKE '%chunk%'
          THEN 'The user was on an older cached version of the app and a screen refused to open until they reloaded.'
        WHEN signature ILIKE '%Script error%'
          THEN 'A third-party or cross-origin script failed; the browser hides the detail, the user sees a broken widget.'
        WHEN signature ILIKE '%permission denied%' OR signature ILIKE '%row-level security%' OR signature ILIKE '%not authorized%'
          THEN 'The user was blocked from data they expected to see and received an access error.'
        WHEN signature ILIKE '%duplicate key%' OR signature ILIKE '%already exists%'
          THEN 'The user tried to create a record that already exists and the save was rejected.'
        WHEN signature ILIKE '%timeout%' OR signature ILIKE '%canceling statement%'
          THEN 'The action took too long and timed out, so the user retried or abandoned the task.'
        WHEN signature ILIKE '%undefined%' OR signature ILIKE '%null%' OR signature ILIKE '%not a function%'
          THEN 'A screen crashed on missing data and the user saw an error card instead of content.'
        WHEN signature ILIKE '%insufficient%' OR signature ILIKE '%balance%'
          THEN 'The user was stopped mid-transaction by a balance or limit check.'
        ELSE 'The user hit an application error on this screen and the action did not complete.'
      END AS user_impact,
      CASE
        WHEN signature ILIKE '%Failed to fetch%' OR signature ILIKE '%NetworkError%' THEN 'Add retry with backoff and an offline state on this route.'
        WHEN signature ILIKE '%dynamically imported module%' OR signature ILIKE '%chunk%' THEN 'Catch the import failure and force a single page reload.'
        WHEN signature ILIKE '%permission denied%' OR signature ILIKE '%row-level security%' THEN 'Review the policy for this role and return a readable message.'
        WHEN signature ILIKE '%timeout%' THEN 'Profile the query behind this screen and add the missing index.'
        ELSE 'Reproduce on the named route, add a guard, and ship a defensive fallback.'
      END AS engineering_action
    FROM errsig
    ORDER BY occurrences DESC
    LIMIT 15
  ),
  db_exceptions AS (
    SELECT src, signature, count(*) AS occurrences, max(seen) AS last_seen
    FROM (
      SELECT 'Scheduled job' AS src,
             left(regexp_replace(return_message, '\s+', ' ', 'g'), 180) AS signature,
             start_time AS seen
      FROM runs WHERE status <> 'succeeded' AND return_message IS NOT NULL
      UNION ALL
      SELECT 'Application' AS src, left(msg, 180), created_at
      FROM errs
      WHERE msg ~* '(ERROR:|violates|duplicate key|permission denied|deadlock|null value|constraint|rolled back|transaction aborted|blocked)'
    ) t
    GROUP BY src, signature
    ORDER BY count(*) DESC
    LIMIT 15
  ),
  sa AS (
    SELECT * FROM signup_attempts WHERE created_at >= v_start AND created_at < v_end
  ),
  anti_bot_reasons AS (
    SELECT COALESCE(NULLIF(reason,''), status, 'unspecified') AS reason, count(*) AS n,
           count(DISTINCT ip) AS ips, count(DISTINCT device_fp) AS devices
    FROM sa WHERE status <> 'success'
    GROUP BY 1 ORDER BY count(*) DESC LIMIT 12
  ),
  anti_bot_ips AS (
    SELECT host(ip) AS ip, count(*) AS attempts,
           count(*) FILTER (WHERE status <> 'success') AS rejected,
           count(DISTINCT COALESCE(email, phone, '')) AS identities,
           count(DISTINCT device_fp) AS devices
    FROM sa WHERE ip IS NOT NULL
    GROUP BY ip HAVING count(*) > 1
    ORDER BY count(*) DESC LIMIT 12
  ),
  anti_bot_devices AS (
    SELECT device_fp, count(*) AS attempts, count(DISTINCT ip) AS ips,
           count(DISTINCT COALESCE(email, phone, '')) AS identities
    FROM sa WHERE device_fp IS NOT NULL
    GROUP BY device_fp HAVING count(*) > 1
    ORDER BY count(*) DESC LIMIT 10
  ),
  auth_fail AS (
    SELECT
      CASE
        WHEN COALESCE(detail->>'reason', detail->>'message','') ILIKE '%invalid login%' OR COALESCE(detail->>'reason', detail->>'message','') ILIKE '%credential%' THEN 'Wrong email or password'
        WHEN COALESCE(detail->>'reason', detail->>'message','') ILIKE '%expired%' THEN 'Expired code or session'
        WHEN COALESCE(detail->>'reason', detail->>'message','') ILIKE '%otp%' THEN 'One-time password rejected'
        WHEN COALESCE(detail->>'reason', detail->>'message','') ILIKE '%rate%' OR COALESCE(detail->>'reason', detail->>'message','') ILIKE '%too many%' THEN 'Rate limited - too many attempts'
        WHEN COALESCE(detail->>'reason', detail->>'message','') ILIKE '%network%' OR COALESCE(detail->>'reason', detail->>'message','') ILIKE '%fetch%' THEN 'Network failure during sign-in'
        WHEN COALESCE(detail->>'reason', detail->>'message','') ILIKE '%not found%' OR COALESCE(detail->>'reason', detail->>'message','') ILIKE '%no user%' THEN 'No account found for that identifier'
        WHEN COALESCE(detail->>'reason', detail->>'message','') = '' THEN 'Unclassified sign-in failure'
        ELSE left(regexp_replace(COALESCE(detail->>'reason', detail->>'message'), '\s+',' ','g'), 90)
      END AS reason,
      phase, user_id
    FROM login_phase_events
    WHERE created_at >= v_start AND created_at < v_end AND status <> 'success'
  ),
  auth_errors AS (
    SELECT reason, count(*) AS n,
           count(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) AS users,
           (SELECT a2.phase FROM auth_fail a2 WHERE a2.reason = a.reason GROUP BY a2.phase ORDER BY count(*) DESC LIMIT 1) AS worst_phase
    FROM auth_fail a GROUP BY reason ORDER BY count(*) DESC LIMIT 12
  ),
  otp_errors AS (
    SELECT COALESCE(NULLIF(reason,''),'unspecified') AS reason, COALESCE(stage,'-') AS stage,
           count(*) AS n, count(DISTINCT phone) AS phones
    FROM otp_login_audit
    WHERE created_at >= v_start AND created_at < v_end AND outcome <> 'success'
    GROUP BY 1,2 ORDER BY count(*) DESC LIMIT 12
  )
  SELECT jsonb_build_object(
    'date', p_date,
    'failed_jobs', COALESCE((SELECT jsonb_agg(to_jsonb(f)) FROM failed_jobs f), '[]'::jsonb),
    'jobs_summary', jsonb_build_object(
      'runs_today', COALESCE((SELECT sum(runs_today) FROM jobagg), 0),
      'failures_today', COALESCE((SELECT sum(failures_today) FROM jobagg), 0),
      'jobs_failing', COALESCE((SELECT count(*) FROM jobagg WHERE failures_today > 0), 0),
      'jobs_broken_all_day', COALESCE((SELECT count(*) FROM jobagg WHERE failures_today > 0 AND success_today = 0), 0)
    ),
    'user_errors', COALESCE((SELECT jsonb_agg(to_jsonb(u)) FROM user_errors u), '[]'::jsonb),
    'errors_summary', jsonb_build_object(
      'distinct_signatures', COALESCE((SELECT count(*) FROM errsig), 0),
      'total_today', COALESCE((SELECT sum(occurrences) FROM errsig), 0),
      'users_today', COALESCE((SELECT count(DISTINCT user_id) FROM errs WHERE user_id IS NOT NULL), 0)
    ),
    'db_exceptions', COALESCE((SELECT jsonb_agg(to_jsonb(d)) FROM db_exceptions d), '[]'::jsonb),
    'anti_bot', jsonb_build_object(
      'attempts_today', COALESCE((SELECT count(*) FROM sa), 0),
      'rejected_today', COALESCE((SELECT count(*) FROM sa WHERE status <> 'success'), 0),
      'distinct_ips', COALESCE((SELECT count(DISTINCT ip) FROM sa), 0),
      'distinct_devices', COALESCE((SELECT count(DISTINCT device_fp) FROM sa), 0),
      'ips_blocked_today', COALESCE((SELECT count(*) FROM blocked_signup_ips WHERE created_at >= v_start AND created_at < v_end), 0),
      'reasons', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM anti_bot_reasons r), '[]'::jsonb),
      'repeat_ips', COALESCE((SELECT jsonb_agg(to_jsonb(i)) FROM anti_bot_ips i), '[]'::jsonb),
      'repeat_devices', COALESCE((SELECT jsonb_agg(to_jsonb(dv)) FROM anti_bot_devices dv), '[]'::jsonb)
    ),
    'auth_errors', COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM auth_errors a), '[]'::jsonb),
    'otp_errors', COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM otp_errors o), '[]'::jsonb)
  ) INTO v_out;

  RETURN COALESCE(v_out, '{}'::jsonb);
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_cto_daily_addendum(date) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_cto_daily_addendum(date) TO service_role;
