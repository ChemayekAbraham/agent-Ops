DROP FUNCTION IF EXISTS public.get_subagent_leaderboard(text,integer,integer);
DROP FUNCTION IF EXISTS public.get_my_subagent_rank(text);

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
  active_count bigint,
  total_subagents bigint,
  active_rate numeric,
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
  pairs AS (
    SELECT DISTINCT s.parent_agent_id, s.sub_agent_id
    FROM public.agent_subagents s
    WHERE (s.status IN ('verified','accepted') OR s.accepted_at IS NOT NULL)
      AND s.sub_agent_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = s.sub_agent_id AND ur.role = 'agent'
      )
  ),
  activity AS (
    SELECT
      pr.parent_agent_id,
      pr.sub_agent_id,
      (
        EXISTS (
          SELECT 1 FROM public.house_listings hl, period_bounds pb
          WHERE hl.agent_id = pr.sub_agent_id
            AND hl.tenant_id IS NULL
            AND hl.created_at >= pb.start_at
        )
        OR EXISTS (
          SELECT 1 FROM public.rent_requests rr, period_bounds pb
          WHERE rr.agent_id = pr.sub_agent_id
            AND rr.created_at >= pb.start_at
        )
        OR EXISTS (
          SELECT 1 FROM public.agent_allocation_traces at, period_bounds pb
          WHERE at.agent_id = pr.sub_agent_id
            AND at.created_at >= pb.start_at
            AND COALESCE(at.amount, 0) > 0
        )
      ) AS is_active
    FROM pairs pr
  ),
  counts AS (
    SELECT
      a.parent_agent_id,
      count(*) FILTER (WHERE a.is_active) AS active_count,
      count(*) AS total_subagents
    FROM activity a
    GROUP BY a.parent_agent_id
  ),
  ranked AS (
    SELECT
      c.parent_agent_id,
      c.active_count,
      c.total_subagents,
      CASE WHEN c.total_subagents > 0
        THEN round(c.active_count::numeric * 100 / c.total_subagents, 0)
        ELSE 0 END AS active_rate,
      row_number() OVER (
        ORDER BY c.active_count DESC,
                 (CASE WHEN c.total_subagents > 0 THEN c.active_count::numeric / c.total_subagents ELSE 0 END) DESC,
                 c.parent_agent_id
      ) AS rnk,
      count(*) OVER () AS total_matched
    FROM counts c
  )
  SELECT
    r.parent_agent_id AS agent_id,
    r.rnk AS rank,
    COALESCE(p.full_name, 'Agent') AS agent_name,
    p.avatar_url,
    r.active_count,
    r.total_subagents,
    r.active_rate,
    r.active_count AS invite_count,
    r.total_matched
  FROM ranked r
  LEFT JOIN public.profiles p ON p.id = r.parent_agent_id
  ORDER BY r.rnk
  LIMIT LEAST(GREATEST(p_limit, 1), 100)
  OFFSET GREATEST(p_offset, 0);
$$;

CREATE OR REPLACE FUNCTION public.get_my_subagent_rank(p_period text DEFAULT 'monthly'::text)
 RETURNS TABLE(agent_id uuid, rank bigint, agent_name text, avatar_url text, active_count bigint, total_subagents bigint, active_rate numeric, invite_count bigint, total_ranked bigint)
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
  pairs AS (
    SELECT DISTINCT s.parent_agent_id, s.sub_agent_id
    FROM public.agent_subagents s
    WHERE (s.status IN ('verified','accepted') OR s.accepted_at IS NOT NULL)
      AND s.sub_agent_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = s.sub_agent_id AND ur.role = 'agent'
      )
  ),
  activity AS (
    SELECT
      pr.parent_agent_id,
      pr.sub_agent_id,
      (
        EXISTS (
          SELECT 1 FROM public.house_listings hl, period_bounds pb
          WHERE hl.agent_id = pr.sub_agent_id
            AND hl.tenant_id IS NULL
            AND hl.created_at >= pb.start_at
        )
        OR EXISTS (
          SELECT 1 FROM public.rent_requests rr, period_bounds pb
          WHERE rr.agent_id = pr.sub_agent_id
            AND rr.created_at >= pb.start_at
        )
        OR EXISTS (
          SELECT 1 FROM public.agent_allocation_traces at, period_bounds pb
          WHERE at.agent_id = pr.sub_agent_id
            AND at.created_at >= pb.start_at
            AND COALESCE(at.amount, 0) > 0
        )
      ) AS is_active
    FROM pairs pr
  ),
  counts AS (
    SELECT
      a.parent_agent_id,
      count(*) FILTER (WHERE a.is_active) AS active_count,
      count(*) AS total_subagents
    FROM activity a
    GROUP BY a.parent_agent_id
  ),
  ranked AS (
    SELECT
      c.parent_agent_id,
      c.active_count,
      c.total_subagents,
      CASE WHEN c.total_subagents > 0
        THEN round(c.active_count::numeric * 100 / c.total_subagents, 0)
        ELSE 0 END AS active_rate,
      row_number() OVER (
        ORDER BY c.active_count DESC,
                 (CASE WHEN c.total_subagents > 0 THEN c.active_count::numeric / c.total_subagents ELSE 0 END) DESC,
                 c.parent_agent_id
      ) AS rnk
    FROM counts c
  ),
  me AS (
    SELECT r.rnk, r.active_count, r.total_subagents, r.active_rate
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
    COALESCE(m.active_count, 0) AS active_count,
    COALESCE(m.total_subagents, 0) AS total_subagents,
    COALESCE(m.active_rate, 0) AS active_rate,
    COALESCE(m.active_count, 0) AS invite_count,
    t.total_ranked
  FROM totals t
  LEFT JOIN me m ON true
  LEFT JOIN public.profiles p ON p.id = auth.uid()
  WHERE auth.uid() IS NOT NULL;
$function$;