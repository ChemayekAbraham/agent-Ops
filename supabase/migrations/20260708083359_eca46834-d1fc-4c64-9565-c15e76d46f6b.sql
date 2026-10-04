
CREATE OR REPLACE FUNCTION public.get_subagent_leaderboard(
  p_period text DEFAULT 'monthly',
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  agent_id uuid,
  rank bigint,
  agent_name text,
  avatar_url text,
  invite_count bigint,
  total_matched bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH period_bounds AS (
    SELECT CASE
      WHEN p_period = 'weekly' THEN date_trunc('week', now())
      ELSE date_trunc('month', now())
    END AS start_at
  ),
  counts AS (
    SELECT
      s.parent_agent_id,
      count(*) AS invite_count
    FROM public.agent_subagents s, period_bounds pb
    WHERE (s.status IN ('verified','accepted') OR s.accepted_at IS NOT NULL)
      AND s.created_at >= pb.start_at
      AND s.sub_agent_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = s.sub_agent_id AND ur.role = 'agent'
      )
    GROUP BY s.parent_agent_id
  ),
  ranked AS (
    SELECT
      c.parent_agent_id,
      c.invite_count,
      row_number() OVER (ORDER BY c.invite_count DESC, c.parent_agent_id) AS rnk,
      count(*) OVER () AS total_matched
    FROM counts c
  )
  SELECT
    r.parent_agent_id AS agent_id,
    r.rnk AS rank,
    COALESCE(p.full_name, 'Agent') AS agent_name,
    p.avatar_url,
    r.invite_count,
    r.total_matched
  FROM ranked r
  LEFT JOIN public.profiles p ON p.id = r.parent_agent_id
  ORDER BY r.rnk
  LIMIT LEAST(GREATEST(p_limit, 1), 100)
  OFFSET GREATEST(p_offset, 0);
$$;

CREATE OR REPLACE FUNCTION public.get_my_subagent_rank(p_period text DEFAULT 'monthly'::text)
 RETURNS TABLE(agent_id uuid, rank bigint, agent_name text, avatar_url text, invite_count bigint, total_ranked bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH period_bounds AS (
    SELECT CASE
      WHEN p_period = 'weekly' THEN date_trunc('week', now())
      ELSE date_trunc('month', now())
    END AS start_at
  ),
  counts AS (
    SELECT
      s.parent_agent_id,
      count(*) AS invite_count
    FROM public.agent_subagents s, period_bounds pb
    WHERE (s.status IN ('verified','accepted') OR s.accepted_at IS NOT NULL)
      AND s.created_at >= pb.start_at
      AND s.sub_agent_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = s.sub_agent_id AND ur.role = 'agent'
      )
    GROUP BY s.parent_agent_id
  ),
  ranked AS (
    SELECT
      c.parent_agent_id,
      c.invite_count,
      row_number() OVER (ORDER BY c.invite_count DESC, c.parent_agent_id) AS rnk
    FROM counts c
  ),
  me AS (
    SELECT r.rnk, r.invite_count
    FROM ranked r
    WHERE r.parent_agent_id = auth.uid()
  ),
  totals AS (
    SELECT COALESCE(max(rnk), 0) AS total_ranked FROM ranked
  )
  SELECT
    auth.uid() AS agent_id,
    COALESCE(m.rnk, t.total_ranked + 1) AS rank,
    COALESCE(p.full_name, 'You') AS agent_name,
    p.avatar_url,
    COALESCE(m.invite_count, 0) AS invite_count,
    t.total_ranked
  FROM totals t
  LEFT JOIN me m ON true
  LEFT JOIN public.profiles p ON p.id = auth.uid()
  WHERE auth.uid() IS NOT NULL;
$function$;
