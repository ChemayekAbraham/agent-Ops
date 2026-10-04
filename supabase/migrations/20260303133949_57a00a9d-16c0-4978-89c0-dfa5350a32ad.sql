CREATE OR REPLACE FUNCTION public.search_agents(search_term text DEFAULT '', result_limit int DEFAULT 50)
RETURNS TABLE(id uuid, full_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, p.full_name
  FROM public.profiles p
  INNER JOIN public.user_roles ur ON ur.user_id = p.id AND ur.role = 'agent'
  WHERE (search_term = '' OR p.full_name ILIKE '%' || search_term || '%')
  ORDER BY p.full_name
  LIMIT result_limit;
$$;