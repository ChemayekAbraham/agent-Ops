CREATE OR REPLACE FUNCTION public.get_listing_agent_contacts(p_listing_ids uuid[])
RETURNS TABLE(listing_id uuid, agent_id uuid, full_name text, phone text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT h.id AS listing_id, p.id AS agent_id, p.full_name, p.phone
  FROM public.house_listings h
  JOIN public.profiles p ON p.id = h.agent_id
  WHERE h.id = ANY(p_listing_ids)
    AND h.status IN ('available', 'pending')
    AND h.is_hidden = false
    AND h.tenant_id IS NULL;
$$;

GRANT EXECUTE ON FUNCTION public.get_listing_agent_contacts(uuid[]) TO authenticated, anon;