CREATE OR REPLACE FUNCTION public.cto_search_profiles(p_term text)
RETURNS TABLE(id uuid, full_name text, phone text, email text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_term text := trim(coalesce(p_term, ''));
  v_like text;
  v_digits text;
BEGIN
  IF length(v_term) < 3 THEN
    RETURN;
  END IF;
  IF NOT (public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'manager')) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  v_like := '%' || v_term || '%';
  v_digits := regexp_replace(v_term, '\D', '', 'g');

  RETURN QUERY
  SELECT p.id, p.full_name, p.phone, p.email
  FROM public.profiles p
  WHERE p.full_name ILIKE v_like
  LIMIT 20;

  IF FOUND THEN RETURN; END IF;

  RETURN QUERY
  SELECT p.id, p.full_name, p.phone, p.email
  FROM public.profiles p
  WHERE (length(v_digits) >= 5 AND p.phone ILIKE '%' || v_digits || '%')
     OR (v_term LIKE '%@%' AND p.email ILIKE v_like)
     OR (v_digits = '' AND p.email ILIKE v_like)
  LIMIT 20;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cto_search_profiles(text) TO authenticated;