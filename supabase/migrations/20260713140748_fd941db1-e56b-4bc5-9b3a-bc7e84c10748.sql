CREATE OR REPLACE FUNCTION public.get_agent_listing_parties(p_agent_id uuid)
RETURNS TABLE(user_id uuid, full_name text, phone text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, p.full_name, p.phone
  FROM public.profiles p
  WHERE (
    auth.uid() = p_agent_id
    OR has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR is_ops_role(auth.uid())
  )
  AND p.id IN (
    SELECT hl.landlord_id FROM public.house_listings hl
      WHERE hl.agent_id = p_agent_id AND hl.landlord_id IS NOT NULL
    UNION
    SELECT hl.tenant_id FROM public.house_listings hl
      WHERE hl.agent_id = p_agent_id AND hl.tenant_id IS NOT NULL
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_agent_listing_parties(uuid) TO authenticated;