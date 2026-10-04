CREATE OR REPLACE FUNCTION public.cto_search_agents(p_query text DEFAULT NULL)
RETURNS TABLE (
  agent_id uuid,
  full_name text,
  phone text,
  is_frozen boolean,
  freeze_scope text,
  blocked_until timestamptz,
  reason text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH agents AS (
    SELECT DISTINCT ur.user_id
    FROM public.user_roles ur
    WHERE ur.role = 'agent'::app_role
  ), active_blocks AS (
    SELECT DISTINCT ON (b.agent_id)
      b.agent_id, b.freeze_scope, b.blocked_until, b.reason
    FROM public.agent_listing_blocks b
    WHERE b.active AND b.blocked_until > now()
    ORDER BY b.agent_id, b.blocked_until DESC
  )
  SELECT
    p.id AS agent_id,
    p.full_name,
    p.phone,
    (ab.agent_id IS NOT NULL) AS is_frozen,
    ab.freeze_scope,
    ab.blocked_until,
    ab.reason
  FROM agents a
  JOIN public.profiles p ON p.id = a.user_id
  LEFT JOIN active_blocks ab ON ab.agent_id = p.id
  WHERE public.is_landlord_ops(auth.uid())
    AND (
      p_query IS NULL OR length(trim(p_query)) = 0
      OR p.full_name ILIKE '%' || trim(p_query) || '%'
      OR p.phone ILIKE '%' || trim(p_query) || '%'
    )
  ORDER BY (ab.agent_id IS NOT NULL) DESC, p.full_name ASC
  LIMIT 40;
$function$;

GRANT EXECUTE ON FUNCTION public.cto_search_agents(text) TO authenticated;