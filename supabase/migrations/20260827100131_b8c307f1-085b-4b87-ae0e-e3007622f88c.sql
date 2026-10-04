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
      AND ur.role IN ('tenant_ops', 'landlord_ops', 'agent_ops', 'partner_ops', 'financial_ops', 'operations', 'manager', 'super_admin', 'coo', 'cfo')
      AND COALESCE(ur.enabled, true) = true
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;

  RETURN QUERY
  SELECT p.id, p.full_name, p.phone
  FROM public.profiles p
  WHERE EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id AND ur.role IN ('agent', 'senior_agent', 'sub_agent') AND COALESCE(ur.enabled, true) = true)
    AND (
      EXISTS (SELECT 1 FROM public.rent_requests rr WHERE rr.agent_id = p.id)
      OR EXISTS (SELECT 1 FROM public.rent_requests rr WHERE rr.assigned_agent_id = p.id)
      OR EXISTS (SELECT 1 FROM public.agent_subagents asa WHERE asa.parent_agent_id = p.id)
      OR EXISTS (SELECT 1 FROM public.agent_subagents asa WHERE asa.sub_agent_id = p.id)
    )
    AND (NULLIF(BTRIM(p.full_name), '') IS NOT NULL OR NULLIF(BTRIM(p.phone), '') IS NOT NULL)
  ORDER BY COALESCE(NULLIF(BTRIM(p.full_name), ''), p.phone, '') ASC LIMIT 100;
END;
$function$;

REVOKE ALL ON FUNCTION public.list_assignable_agents() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_assignable_agents() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_assignable_agents() TO service_role;