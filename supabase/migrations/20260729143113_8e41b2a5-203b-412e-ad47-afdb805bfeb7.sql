CREATE OR REPLACE FUNCTION public.get_agent_advance_activity_correlation(p_days integer DEFAULT 90)
RETURNS TABLE (
  agent_id uuid,
  full_name text,
  advance_count integer,
  advance_principal numeric,
  approved_count integer,
  collections_count integer,
  collections_amount numeric,
  tenants_count integer,
  listings_count integer,
  subagents_count integer,
  visits_count integer,
  activity_score numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH win AS (SELECT (now() - make_interval(days => GREATEST(p_days,1)))::timestamptz AS since),
  req AS (
    SELECT r.agent_id,
           count(*)::int AS advance_count,
           COALESCE(sum(r.principal),0)::numeric AS advance_principal,
           count(*) FILTER (WHERE r.status NOT IN ('rejected','cancelled'))::int AS approved_count
    FROM agent_advance_requests r, win
    WHERE r.created_at >= win.since
    GROUP BY r.agent_id
  ),
  col AS (
    SELECT c.agent_id, count(*)::int AS collections_count,
           COALESCE(sum(c.amount),0)::numeric AS collections_amount,
           count(DISTINCT c.tenant_id)::int AS tenants_count
    FROM agent_collections c, win
    WHERE c.created_at >= win.since
    GROUP BY c.agent_id
  ),
  lst AS (
    SELECT h.agent_id, count(*)::int AS listings_count
    FROM house_listings h, win
    WHERE h.created_at >= win.since AND h.agent_id IS NOT NULL
    GROUP BY h.agent_id
  ),
  sub AS (
    SELECT s.parent_agent_id AS agent_id, count(*)::int AS subagents_count
    FROM agent_subagents s, win
    WHERE s.created_at >= win.since
    GROUP BY s.parent_agent_id
  ),
  vis AS (
    SELECT v.agent_id, count(*)::int AS visits_count
    FROM agent_visits v, win
    WHERE v.created_at >= win.since
    GROUP BY v.agent_id
  ),
  ids AS (
    SELECT agent_id FROM req
    UNION SELECT agent_id FROM col
    UNION SELECT agent_id FROM lst
    UNION SELECT agent_id FROM sub
    UNION SELECT agent_id FROM vis
  )
  SELECT i.agent_id,
         COALESCE(p.full_name, 'Unknown') AS full_name,
         COALESCE(req.advance_count,0),
         COALESCE(req.advance_principal,0),
         COALESCE(req.approved_count,0),
         COALESCE(col.collections_count,0),
         COALESCE(col.collections_amount,0),
         COALESCE(col.tenants_count,0),
         COALESCE(lst.listings_count,0),
         COALESCE(sub.subagents_count,0),
         COALESCE(vis.visits_count,0),
         (COALESCE(col.collections_count,0) * 1.0
          + COALESCE(col.tenants_count,0) * 2.0
          + COALESCE(lst.listings_count,0) * 1.5
          + COALESCE(sub.subagents_count,0) * 2.0
          + COALESCE(vis.visits_count,0) * 0.5)::numeric AS activity_score
  FROM ids i
  LEFT JOIN profiles p ON p.id = i.agent_id
  LEFT JOIN req ON req.agent_id = i.agent_id
  LEFT JOIN col ON col.agent_id = i.agent_id
  LEFT JOIN lst ON lst.agent_id = i.agent_id
  LEFT JOIN sub ON sub.agent_id = i.agent_id
  LEFT JOIN vis ON vis.agent_id = i.agent_id
  WHERE i.agent_id IS NOT NULL
  ORDER BY 12 DESC
  LIMIT 500;
$$;

CREATE OR REPLACE FUNCTION public.get_advance_activity_monthly_trend(p_months integer DEFAULT 12)
RETURNS TABLE (
  month_start date,
  advance_requests integer,
  advance_principal numeric,
  collections_count integer,
  collections_amount numeric,
  active_agents integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH months AS (
    SELECT generate_series(
      date_trunc('month', now() - make_interval(months => GREATEST(p_months,1) - 1))::date,
      date_trunc('month', now())::date,
      interval '1 month'
    )::date AS m
  ),
  req AS (
    SELECT date_trunc('month', created_at)::date AS m,
           count(*)::int AS c, COALESCE(sum(principal),0)::numeric AS amt
    FROM agent_advance_requests
    WHERE created_at >= date_trunc('month', now() - make_interval(months => GREATEST(p_months,1) - 1))
    GROUP BY 1
  ),
  col AS (
    SELECT date_trunc('month', created_at)::date AS m,
           count(*)::int AS c, COALESCE(sum(amount),0)::numeric AS amt,
           count(DISTINCT agent_id)::int AS agents
    FROM agent_collections
    WHERE created_at >= date_trunc('month', now() - make_interval(months => GREATEST(p_months,1) - 1))
    GROUP BY 1
  )
  SELECT months.m,
         COALESCE(req.c,0), COALESCE(req.amt,0),
         COALESCE(col.c,0), COALESCE(col.amt,0), COALESCE(col.agents,0)
  FROM months
  LEFT JOIN req ON req.m = months.m
  LEFT JOIN col ON col.m = months.m
  ORDER BY months.m;
$$;

REVOKE ALL ON FUNCTION public.get_agent_advance_activity_correlation(integer) FROM public, anon;
REVOKE ALL ON FUNCTION public.get_advance_activity_monthly_trend(integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_agent_advance_activity_correlation(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_advance_activity_monthly_trend(integer) TO authenticated, service_role;