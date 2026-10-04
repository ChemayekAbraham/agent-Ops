CREATE OR REPLACE FUNCTION public.is_proxy_agent_for_partner(_agent uuid, _partner uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.proxy_agent_assignments paa
    WHERE paa.agent_id = _agent
      AND paa.beneficiary_id = _partner
      AND paa.is_active = true
      AND paa.approval_status = 'approved'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_proxy_agent_for_partner(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_proxy_agent_for_partner(uuid, uuid) TO service_role;

CREATE POLICY "Proxy agents can view partner profiles"
ON public.profiles
FOR SELECT
TO authenticated
USING (public.is_proxy_agent_for_partner(auth.uid(), id));