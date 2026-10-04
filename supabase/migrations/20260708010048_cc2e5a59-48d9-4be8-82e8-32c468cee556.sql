CREATE OR REPLACE FUNCTION public.get_agent_ops_agent_stats(p_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH RECURSIVE
base_ops AS (
  SELECT agent_id AS uid FROM house_listings WHERE agent_id IS NOT NULL
  UNION SELECT agent_id FROM promissory_notes WHERE agent_id IS NOT NULL
  UNION SELECT agent_id FROM rent_requests WHERE agent_id IS NOT NULL AND agent_id <> tenant_id
),
edges AS (
  SELECT parent_agent_id AS parent, sub_agent_id AS child FROM agent_subagents WHERE parent_agent_id IS NOT NULL AND sub_agent_id IS NOT NULL
  UNION SELECT referrer_id, referred_id FROM referrals WHERE referrer_id IS NOT NULL AND referred_id IS NOT NULL
  UNION SELECT referrer_id, id FROM profiles WHERE referrer_id IS NOT NULL
),
agents_rec AS (
  SELECT uid FROM base_ops
  UNION
  SELECT e.parent FROM edges e JOIN agents_rec a ON a.uid = e.child
),
agents AS (SELECT DISTINCT uid FROM agents_rec WHERE uid IS NOT NULL),
ops AS (
  SELECT agent_id AS uid, created_at FROM house_listings WHERE agent_id IS NOT NULL
  UNION ALL SELECT agent_id, created_at FROM promissory_notes WHERE agent_id IS NOT NULL
  UNION ALL SELECT agent_id, created_at FROM rent_requests WHERE agent_id IS NOT NULL AND agent_id <> tenant_id
  UNION ALL SELECT parent_agent_id, created_at FROM agent_subagents WHERE parent_agent_id IS NOT NULL
),
win_ops AS (
  SELECT o.uid, o.created_at
  FROM ops o
  JOIN agents a ON a.uid = o.uid
  WHERE o.created_at >= (now() - make_interval(days => GREATEST(p_days, 1)))
),
daily AS (
  SELECT date_trunc('day', created_at)::date AS d,
         count(DISTINCT uid) AS active_agents,
         count(*) AS operations
  FROM win_ops
  GROUP BY 1
),
days AS (
  SELECT generate_series(
    (now() - make_interval(days => GREATEST(p_days, 1) - 1))::date,
    now()::date,
    interval '1 day'
  )::date AS d
)
SELECT jsonb_build_object(
  'total_users', (SELECT count(*) FROM profiles),
  'total_agents', (SELECT count(*) FROM agents),
  'active_agents', (SELECT count(DISTINCT uid) FROM win_ops),
  'active_users', (
     SELECT count(DISTINCT user_id) FROM system_events
     WHERE user_id IS NOT NULL
       AND created_at >= (now() - make_interval(days => GREATEST(p_days, 1)))
  ),
  'active_users_prev', (
     SELECT count(DISTINCT user_id) FROM system_events
     WHERE user_id IS NOT NULL
       AND created_at >= (now() - make_interval(days => GREATEST(p_days, 1) * 2))
       AND created_at <  (now() - make_interval(days => GREATEST(p_days, 1)))
  ),
  'operations', (SELECT count(*) FROM win_ops),
  'window_days', GREATEST(p_days, 1),
  'criteria', jsonb_build_object(
     'house_listings', (SELECT count(DISTINCT agent_id) FROM house_listings WHERE agent_id IN (SELECT uid FROM agents)),
     'promissory_notes', (SELECT count(DISTINCT agent_id) FROM promissory_notes WHERE agent_id IN (SELECT uid FROM agents)),
     'behalf_rent_requests', (SELECT count(DISTINCT agent_id) FROM rent_requests WHERE agent_id IN (SELECT uid FROM agents) AND agent_id <> tenant_id),
     'subagents', (SELECT count(DISTINCT parent_agent_id) FROM agent_subagents WHERE parent_agent_id IN (SELECT uid FROM agents))
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
$function$;