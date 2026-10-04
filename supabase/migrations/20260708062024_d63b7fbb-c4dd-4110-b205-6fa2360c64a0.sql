
-- Leaderboard: ranked agents by successful sub-agent registrations for a period
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
    GROUP BY s.parent_agent_id
  ),
  ranked AS (
    SELECT
      c.parent_agent_id,
      c.invite_count,
      rank() OVER (ORDER BY c.invite_count DESC) AS rnk,
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
  ORDER BY r.rnk, agent_name
  LIMIT LEAST(GREATEST(p_limit, 1), 100)
  OFFSET GREATEST(p_offset, 0);
$$;

-- Current user's rank for a period
CREATE OR REPLACE FUNCTION public.get_my_subagent_rank(
  p_period text DEFAULT 'monthly'
)
RETURNS TABLE (
  agent_id uuid,
  rank bigint,
  agent_name text,
  avatar_url text,
  invite_count bigint,
  total_ranked bigint
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
    GROUP BY s.parent_agent_id
  ),
  ranked AS (
    SELECT
      c.parent_agent_id,
      c.invite_count,
      rank() OVER (ORDER BY c.invite_count DESC) AS rnk,
      count(*) OVER () AS total_ranked
    FROM counts c
  )
  SELECT
    auth.uid() AS agent_id,
    r.rnk AS rank,
    COALESCE(p.full_name, 'You') AS agent_name,
    p.avatar_url,
    COALESCE(r.invite_count, 0) AS invite_count,
    COALESCE(r.total_ranked, 0) AS total_ranked
  FROM ranked r
  LEFT JOIN public.profiles p ON p.id = auth.uid()
  WHERE r.parent_agent_id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.get_subagent_leaderboard(text, int, int) FROM public, anon;
REVOKE ALL ON FUNCTION public.get_my_subagent_rank(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_subagent_leaderboard(text, int, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_subagent_rank(text) TO authenticated, service_role;
