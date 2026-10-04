CREATE OR REPLACE FUNCTION public.search_supporters(search_term text, result_limit int DEFAULT 20)
RETURNS TABLE(id uuid, full_name text, phone text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, p.full_name, p.phone
  FROM public.profiles p
  INNER JOIN public.user_roles ur ON ur.user_id = p.id AND ur.role = 'supporter'
  WHERE p.full_name ILIKE '%' || search_term || '%'
     OR p.phone ILIKE '%' || search_term || '%'
  LIMIT result_limit;
$$;