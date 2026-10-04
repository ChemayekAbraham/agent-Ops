DROP FUNCTION IF EXISTS public.get_my_subagent_tenant_profiles();

CREATE OR REPLACE FUNCTION public.get_my_subagent_tenant_profiles()
RETURNS TABLE(
  sub_agent_id uuid,
  id uuid,
  full_name text,
  phone text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH my_subagents AS (
    SELECT sa.sub_agent_id
    FROM public.agent_subagents sa
    WHERE sa.parent_agent_id = auth.uid()
  ),
  tenant_links AS (
    -- Tenants from rent requests posted by the sub-agent
    SELECT DISTINCT rr.agent_id AS sub_agent_id, rr.tenant_id AS tenant_id
    FROM public.rent_requests rr
    WHERE rr.agent_id IN (SELECT sub_agent_id FROM my_subagents)
      AND rr.tenant_id IS NOT NULL

    UNION

    -- Tenants from rent requests assigned to the sub-agent
    SELECT DISTINCT rr.assigned_agent_id AS sub_agent_id, rr.tenant_id AS tenant_id
    FROM public.rent_requests rr
    WHERE rr.assigned_agent_id IN (SELECT sub_agent_id FROM my_subagents)
      AND rr.tenant_id IS NOT NULL

    UNION

    -- Tenants who signed up using the sub-agent as referrer
    SELECT DISTINCT p.referrer_id AS sub_agent_id, p.id AS tenant_id
    FROM public.profiles p
    WHERE p.referrer_id IN (SELECT sub_agent_id FROM my_subagents)

    UNION

    -- Tenants from the referrals table where sub-agent is referrer
    SELECT DISTINCT r.referrer_id AS sub_agent_id, r.referred_id AS tenant_id
    FROM public.referrals r
    WHERE r.referrer_id IN (SELECT sub_agent_id FROM my_subagents)
      AND r.referred_id IS NOT NULL

    UNION

    -- Managed tenants looked after by the sub-agent
    SELECT DISTINCT p.managing_agent_id AS sub_agent_id, p.id AS tenant_id
    FROM public.profiles p
    WHERE p.managing_agent_id IN (SELECT sub_agent_id FROM my_subagents)
      AND p.managed_by_agent = true

    UNION

    -- Tenants placed in houses listed by the sub-agent
    SELECT DISTINCT hl.agent_id AS sub_agent_id, hl.tenant_id AS tenant_id
    FROM public.house_listings hl
    WHERE hl.agent_id IN (SELECT sub_agent_id FROM my_subagents)
      AND hl.tenant_id IS NOT NULL
  )
  SELECT tl.sub_agent_id, p.id, p.full_name, p.phone
  FROM tenant_links tl
  JOIN public.profiles p ON p.id = tl.tenant_id;
$function$;

GRANT EXECUTE ON FUNCTION public.get_my_subagent_tenant_profiles() TO authenticated;