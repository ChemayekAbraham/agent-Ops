CREATE OR REPLACE FUNCTION public.agent_ops_collection_agents()
RETURNS TABLE(agent_id uuid, ever_collected boolean, last_collection timestamptz, live_plan boolean, is_sub_agent boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
WITH collected AS (
  SELECT ac.agent_id AS uid, max(ac.created_at) AS last_ts
    FROM agent_collections ac
   WHERE ac.agent_id IS NOT NULL
   GROUP BY 1
), live AS (
  SELECT rr.agent_id AS uid FROM rent_requests rr
   WHERE rr.status IN ('funded','repaying') AND rr.agent_id IS NOT NULL
  UNION
  SELECT rr.assigned_agent_id FROM rent_requests rr
   WHERE rr.status IN ('funded','repaying') AND rr.assigned_agent_id IS NOT NULL
), uni AS (
  SELECT uid FROM collected UNION SELECT uid FROM live
)
SELECT u.uid,
       (c.uid IS NOT NULL),
       c.last_ts,
       (l.uid IS NOT NULL),
       EXISTS (SELECT 1 FROM agent_subagents s WHERE s.sub_agent_id = u.uid AND s.status = 'verified')
  FROM uni u
  LEFT JOIN collected c ON c.uid = u.uid
  LEFT JOIN live l ON l.uid = u.uid
 WHERE u.uid IS NOT NULL;
$fn$;

REVOKE ALL ON FUNCTION public.agent_ops_collection_agents() FROM public;
GRANT EXECUTE ON FUNCTION public.agent_ops_collection_agents() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_agent_ops_agent_stats(p_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
WITH uni AS (
  SELECT * FROM public.agent_ops_collection_agents()
),
scored AS (
  SELECT agent_id,
         is_sub_agent,
         (live_plan OR last_collection >= now() - interval '30 days') AS is_active
    FROM uni
),
win_ops AS (
  SELECT ac.agent_id AS uid, ac.created_at
    FROM agent_collections ac
    JOIN uni a ON a.agent_id = ac.agent_id
   WHERE ac.created_at >= (now() - make_interval(days => GREATEST(p_days, 1)))
),
daily AS (
  SELECT date_trunc('day', created_at)::date AS d,
         count(DISTINCT uid) AS active_agents,
         count(*) AS operations
    FROM win_ops GROUP BY 1
),
days AS (
  SELECT generate_series(
    (now() - make_interval(days => GREATEST(p_days, 1) - 1))::date,
    now()::date, interval '1 day')::date AS d
)
SELECT jsonb_build_object(
  'total_users', (SELECT count(*) FROM profiles),
  'total_agents', (SELECT count(*) FROM scored),
  'active_agents', (SELECT count(*) FROM scored WHERE is_active),
  'inactive_agents', (SELECT count(*) FROM scored WHERE NOT is_active),
  'sub_agents', (SELECT count(*) FROM scored WHERE is_sub_agent),
  'primary_agents', (SELECT count(*) FROM scored WHERE NOT is_sub_agent),
  'ever_collected', (SELECT count(*) FROM uni WHERE ever_collected),
  'live_plan_agents', (SELECT count(*) FROM uni WHERE live_plan),
  'collected_in_window', (SELECT count(DISTINCT uid) FROM win_ops),
  'active_users', (
     SELECT count(DISTINCT user_id) FROM system_events
      WHERE user_id IS NOT NULL
        AND created_at >= (now() - make_interval(days => GREATEST(p_days, 1)))),
  'active_users_prev', (
     SELECT count(DISTINCT user_id) FROM system_events
      WHERE user_id IS NOT NULL
        AND created_at >= (now() - make_interval(days => GREATEST(p_days, 1) * 2))
        AND created_at <  (now() - make_interval(days => GREATEST(p_days, 1)))),
  'operations', (SELECT count(*) FROM win_ops),
  'window_days', GREATEST(p_days, 1),
  'criteria', jsonb_build_object(
     'collections', (SELECT count(*) FROM uni WHERE ever_collected),
     'live_plans', (SELECT count(*) FROM uni WHERE live_plan),
     'sub_agents', (SELECT count(*) FROM uni WHERE is_sub_agent),
     'primary_agents', (SELECT count(*) FROM uni WHERE NOT is_sub_agent)
  ),
  'trend', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'day', to_char(days.d, 'YYYY-MM-DD'),
      'active_agents', COALESCE(daily.active_agents, 0),
      'operations', COALESCE(daily.operations, 0)
    ) ORDER BY days.d)
    FROM days LEFT JOIN daily ON daily.d = days.d
  ), '[]'::jsonb)
);
$fn$;

DO $do$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc WHERE proname = 'get_agent_ops_overview'
     AND pronamespace = 'public'::regnamespace
   LIMIT 1;
  IF v_def IS NULL THEN
    RAISE NOTICE 'get_agent_ops_overview not found, skipping';
    RETURN;
  END IF;

  v_def := replace(v_def,
    'WHERE rr.agent_id IS NOT NULL AND rr.tenant_id IS NOT NULL AND rr.agent_id <> rr.tenant_id',
    'WHERE rr.status IN (''funded'',''repaying'') AND rr.agent_id IS NOT NULL');

  v_def := replace(v_def,
    'SELECT lr.uid, lr.created_at FROM listing_ranked lr WHERE lr.rn = 3',
    'SELECT rr2.assigned_agent_id, MIN(rr2.created_at) FROM rent_requests rr2 WHERE rr2.status IN (''funded'',''repaying'') AND rr2.assigned_agent_id IS NOT NULL GROUP BY rr2.assigned_agent_id');

  v_def := replace(v_def,
    E'    FROM agent_subagents\n    WHERE sub_agent_id IS NOT NULL\n    GROUP BY sub_agent_id;',
    E'    FROM agent_subagents\n    WHERE sub_agent_id IS NOT NULL AND status = ''verified''\n      AND sub_agent_id IN (SELECT agent_id FROM tmp_qual)\n    GROUP BY sub_agent_id;');

  EXECUTE v_def;
END
$do$;