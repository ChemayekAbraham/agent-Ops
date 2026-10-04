CREATE OR REPLACE FUNCTION public.search_agents_by_phone(
  p_phone_term text DEFAULT '',
  p_limit int DEFAULT 10
)
RETURNS TABLE(id uuid, full_name text, phone text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, p.full_name, p.phone
  FROM public.profiles p
  INNER JOIN public.user_roles ur ON ur.user_id = p.id AND ur.role = 'agent'
  WHERE p_phone_term = ''
     OR p.phone ILIKE '%' || p_phone_term || '%'
     OR p.phone ILIKE '%0' || p_phone_term || '%'
     OR p.phone ILIKE '%256' || p_phone_term || '%'
  ORDER BY p.full_name
  LIMIT p_limit;
$$;

COMMENT ON FUNCTION public.search_agents_by_phone(text, int) IS 'Search agents by partial phone number. Returns agent id, name and phone for autocomplete.';