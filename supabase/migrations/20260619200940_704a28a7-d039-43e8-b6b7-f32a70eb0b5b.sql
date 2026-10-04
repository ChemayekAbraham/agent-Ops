DROP FUNCTION IF EXISTS public.get_listing_agent_contacts(uuid[]);

CREATE FUNCTION public.get_listing_agent_contacts(p_listing_ids uuid[])
RETURNS TABLE(
  listing_id uuid,
  agent_id uuid,
  full_name text,
  phone text,
  avg_rating numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    h.id AS listing_id, 
    p.id AS agent_id, 
    p.full_name, 
    p.phone,
    r.avg_rating
  FROM public.house_listings h
  JOIN public.profiles p ON p.id = h.agent_id
  LEFT JOIN LATERAL (
    SELECT ROUND(AVG(ur.rating)::numeric, 1) AS avg_rating
    FROM public.user_reviews ur
    WHERE ur.reviewed_user_id = p.id
  ) r ON true
  WHERE h.id = ANY(p_listing_ids)
    AND h.status IN ('available', 'pending')
    AND h.is_hidden = false
    AND h.tenant_id IS NULL;
$$;

GRANT EXECUTE ON FUNCTION public.get_listing_agent_contacts(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_listing_agent_contacts(uuid[]) TO anon;