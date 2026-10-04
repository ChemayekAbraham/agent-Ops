CREATE OR REPLACE FUNCTION public.find_lc1_by_phone(p_phone text)
RETURNS TABLE (id uuid, name text, verified boolean, village text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT l.id, l.name, l.verified, l.village
  FROM public.lc1_chairpersons l
  WHERE public.normalize_phone(l.phone) = public.normalize_phone(p_phone)
  ORDER BY l.verified DESC NULLS LAST, l.created_at ASC
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.find_lc1_by_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.find_lc1_by_phone(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.find_lc1_by_phone(text) TO service_role;