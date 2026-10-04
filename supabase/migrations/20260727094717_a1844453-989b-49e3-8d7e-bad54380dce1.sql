CREATE OR REPLACE FUNCTION public.get_agent_directory_region_breakdown(_verified_only boolean DEFAULT false)
RETURNS TABLE(
  region text,
  district text,
  agent_count bigint,
  verified_count bigint,
  active_30d bigint
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    COALESCE(NULLIF(TRIM(p.region), ''), 'Unassigned') AS region,
    COALESCE(NULLIF(TRIM(p.district), ''), 'Unassigned') AS district,
    COUNT(*)::bigint AS agent_count,
    COUNT(*) FILTER (WHERE p.verified IS TRUE)::bigint AS verified_count,
    COUNT(*) FILTER (WHERE p.last_active_at >= (now() - interval '30 days'))::bigint AS active_30d
  FROM public.agent_ops_qualifying_agent_ids() q
  JOIN public.profiles p ON p.id = q.agent_id
  WHERE (NOT _verified_only OR p.verified IS TRUE)
  GROUP BY 1, 2
  ORDER BY region ASC, agent_count DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_directory_region_breakdown(boolean) TO authenticated, service_role;