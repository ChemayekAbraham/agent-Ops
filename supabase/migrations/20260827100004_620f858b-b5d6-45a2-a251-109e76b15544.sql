DROP FUNCTION IF EXISTS public.list_assignable_agents(text, integer);

CREATE OR REPLACE FUNCTION public.list_assignable_agents()
RETURNS TABLE(id uuid, full_name text, phone text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role IN ('tenant_ops', 'operations', 'manager', 'super_admin', 'coo')
      AND COALESCE(ur.enabled, true) = true
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT p.id, p.full_name, p.phone
  FROM public.profiles p
  WHERE EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = p.id
      AND ur.role IN ('agent', 'senior_agent', 'sub_agent')
      AND COALESCE(ur.enabled, true) = true
  )
    AND (
      EXISTS (SELECT 1 FROM public.rent_requests rr WHERE rr.agent_id = p.id)
      OR EXISTS (SELECT 1 FROM public.rent_requests rr WHERE rr.assigned_agent_id = p.id)
      OR EXISTS (SELECT 1 FROM public.agent_subagents asa WHERE asa.parent_agent_id = p.id AND asa.status IN ('verified', 'pending_acceptance'))
      OR EXISTS (SELECT 1 FROM public.agent_subagents asa WHERE asa.sub_agent_id = p.id AND asa.status IN ('verified', 'pending_acceptance'))
    )
    AND (NULLIF(BTRIM(p.full_name), '') IS NOT NULL OR NULLIF(BTRIM(p.phone), '') IS NOT NULL)
  ORDER BY COALESCE(NULLIF(BTRIM(p.full_name), ''), p.phone, '') ASC
  LIMIT 100;
END;
$function$;

CREATE FUNCTION public.list_assignable_agents(
  p_search text,
  p_limit integer DEFAULT 100
)
RETURNS TABLE(id uuid, full_name text, phone text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role IN ('tenant_ops', 'operations', 'manager', 'super_admin', 'coo')
      AND COALESCE(ur.enabled, true) = true
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT p.id, p.full_name, p.phone
  FROM public.profiles p
  WHERE EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = p.id
      AND ur.role IN ('agent', 'senior_agent', 'sub_agent')
      AND COALESCE(ur.enabled, true) = true
  )
    AND (
      EXISTS (SELECT 1 FROM public.rent_requests rr WHERE rr.agent_id = p.id)
      OR EXISTS (SELECT 1 FROM public.rent_requests rr WHERE rr.assigned_agent_id = p.id)
      OR EXISTS (SELECT 1 FROM public.agent_subagents asa WHERE asa.parent_agent_id = p.id AND asa.status IN ('verified', 'pending_acceptance'))
      OR EXISTS (SELECT 1 FROM public.agent_subagents asa WHERE asa.sub_agent_id = p.id AND asa.status IN ('verified', 'pending_acceptance'))
    )
    AND (NULLIF(BTRIM(p.full_name), '') IS NOT NULL OR NULLIF(BTRIM(p.phone), '') IS NOT NULL)
    AND (
      NULLIF(BTRIM(p_search), '') IS NULL
      OR p.full_name ILIKE '%' || BTRIM(p_search) || '%'
      OR p.phone ILIKE '%' || BTRIM(p_search) || '%'
    )
  ORDER BY COALESCE(NULLIF(BTRIM(p.full_name), ''), p.phone, '') ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200);
END;
$function$;

REVOKE ALL ON FUNCTION public.list_assignable_agents() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_assignable_agents(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_assignable_agents() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_assignable_agents() TO service_role;
GRANT EXECUTE ON FUNCTION public.list_assignable_agents(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_assignable_agents(text, integer) TO service_role;