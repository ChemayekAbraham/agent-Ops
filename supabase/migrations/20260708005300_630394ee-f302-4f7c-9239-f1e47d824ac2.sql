
CREATE OR REPLACE FUNCTION public.get_agent_ops_criteria_users(p_criterion text)
RETURNS TABLE(user_id uuid, full_name text, phone text, avatar_url text, cnt bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ids AS (
    SELECT agent_id AS uid, count(*) AS c
    FROM house_listings
    WHERE p_criterion = 'house_listings' AND agent_id IS NOT NULL
    GROUP BY agent_id
    UNION ALL
    SELECT agent_id, count(*)
    FROM promissory_notes
    WHERE p_criterion = 'promissory_notes' AND agent_id IS NOT NULL
    GROUP BY agent_id
    UNION ALL
    SELECT agent_id, count(*)
    FROM rent_requests
    WHERE p_criterion = 'behalf_rent_requests' AND agent_id IS NOT NULL AND agent_id <> tenant_id
    GROUP BY agent_id
    UNION ALL
    SELECT parent_agent_id, count(*)
    FROM agent_subagents
    WHERE p_criterion = 'subagents' AND parent_agent_id IS NOT NULL
    GROUP BY parent_agent_id
  )
  SELECT ids.uid, p.full_name, p.phone, p.avatar_url, ids.c
  FROM ids
  LEFT JOIN profiles p ON p.id = ids.uid
  ORDER BY ids.c DESC
  LIMIT 1000;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_ops_criteria_users(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_agent_ops_criteria_users(text) TO service_role;
