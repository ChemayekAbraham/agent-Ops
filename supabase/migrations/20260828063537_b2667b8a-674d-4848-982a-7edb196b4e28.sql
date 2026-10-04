CREATE OR REPLACE FUNCTION public.get_agent_ops_criteria_users(p_criterion text)
RETURNS TABLE(user_id uuid, full_name text, phone text, avatar_url text, cnt bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  WITH uni AS (
    SELECT * FROM public.agent_ops_collection_agents()
  ),
  ids AS (
    -- new (canonical) segments
    SELECT ac.agent_id AS uid, count(*) AS c
      FROM agent_collections ac
     WHERE p_criterion = 'collections' AND ac.agent_id IS NOT NULL
     GROUP BY ac.agent_id
    UNION ALL
    SELECT u.agent_id, (SELECT count(*) FROM rent_requests rr
                          WHERE rr.status IN ('funded','repaying')
                            AND (rr.agent_id = u.agent_id OR rr.assigned_agent_id = u.agent_id))
      FROM uni u
     WHERE p_criterion = 'live_plans' AND u.live_plan
    UNION ALL
    SELECT u.agent_id, 1::bigint FROM uni u
     WHERE p_criterion = 'sub_agents' AND u.is_sub_agent
    UNION ALL
    SELECT u.agent_id, 1::bigint FROM uni u
     WHERE p_criterion = 'primary_agents' AND NOT u.is_sub_agent
    UNION ALL
    SELECT u.agent_id, 1::bigint FROM uni u
     WHERE p_criterion = 'inactive_agents'
       AND NOT u.live_plan
       AND (u.last_collection IS NULL OR u.last_collection < now() - interval '30 days')
    UNION ALL
    SELECT u.agent_id, 1::bigint FROM uni u
     WHERE p_criterion = 'active_agents'
       AND (u.live_plan OR u.last_collection >= now() - interval '30 days')
    -- legacy segments kept for backward compatibility
    UNION ALL
    SELECT hl.agent_id, count(*) FROM house_listings hl
     WHERE p_criterion = 'house_listings' AND hl.agent_id IS NOT NULL GROUP BY hl.agent_id
    UNION ALL
    SELECT pn.agent_id, count(*) FROM promissory_notes pn
     WHERE p_criterion = 'promissory_notes' AND pn.agent_id IS NOT NULL GROUP BY pn.agent_id
    UNION ALL
    SELECT rr.agent_id, count(*) FROM rent_requests rr
     WHERE p_criterion = 'behalf_rent_requests' AND rr.agent_id IS NOT NULL AND rr.agent_id <> rr.tenant_id
     GROUP BY rr.agent_id
    UNION ALL
    SELECT s.parent_agent_id, count(*) FROM agent_subagents s
     WHERE p_criterion = 'subagents' AND s.parent_agent_id IS NOT NULL GROUP BY s.parent_agent_id
  )
  SELECT ids.uid, p.full_name, p.phone, p.avatar_url, ids.c
  FROM ids
  LEFT JOIN profiles p ON p.id = ids.uid
  ORDER BY ids.c DESC
  LIMIT 1000;
$fn$;