CREATE OR REPLACE FUNCTION public.list_assignable_agents()
RETURNS TABLE(id uuid, full_name text, phone text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH caller_authorized AS (
    SELECT EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role IN ('tenant_ops', 'operations', 'manager', 'super_admin', 'coo')
        AND COALESCE(ur.enabled, true) = true
    ) AS allowed
  ),
  real_agent_ids AS (
    SELECT rr.agent_id AS user_id
    FROM public.rent_requests rr
    WHERE rr.agent_id IS NOT NULL

    UNION

    SELECT rr.assigned_agent_id AS user_id
    FROM public.rent_requests rr
    WHERE rr.assigned_agent_id IS NOT NULL

    UNION

    SELECT asa.parent_agent_id AS user_id
    FROM public.agent_subagents asa
    WHERE asa.parent_agent_id IS NOT NULL
      AND asa.status IN ('verified', 'pending_acceptance')

    UNION

    SELECT asa.sub_agent_id AS user_id
    FROM public.agent_subagents asa
    WHERE asa.sub_agent_id IS NOT NULL
      AND asa.status IN ('verified', 'pending_acceptance')
  )
  SELECT p.id, p.full_name, p.phone
  FROM caller_authorized ca
  CROSS JOIN real_agent_ids rai
  JOIN public.profiles p ON p.id = rai.user_id
  WHERE ca.allowed
    AND EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = p.id
        AND ur.role IN ('agent', 'senior_agent', 'sub_agent')
        AND COALESCE(ur.enabled, true) = true
    )
    AND (NULLIF(BTRIM(p.full_name), '') IS NOT NULL OR NULLIF(BTRIM(p.phone), '') IS NOT NULL)
  ORDER BY COALESCE(NULLIF(BTRIM(p.full_name), ''), p.phone, '') ASC;
$function$;

REVOKE ALL ON FUNCTION public.list_assignable_agents() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_assignable_agents() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_assignable_agents() TO service_role;