DROP FUNCTION IF EXISTS public.cto_search_profiles(text);

CREATE OR REPLACE FUNCTION public.cto_search_profiles(
  p_term text,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(id uuid, full_name text, phone text, email text, match_rank integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_term text := trim(coalesce(p_term, ''));
  v_like text;
  v_digits text;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
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
  SELECT p.id, p.full_name, p.phone, p.email,
         CASE
           WHEN p.full_name ILIKE v_like THEN 1
           WHEN length(v_digits) >= 5 AND p.phone ILIKE '%' || v_digits || '%' THEN 2
           ELSE 3
         END AS match_rank
  FROM public.profiles p
  WHERE p.full_name ILIKE v_like
     OR (length(v_digits) >= 5 AND p.phone ILIKE '%' || v_digits || '%')
     OR (length(v_digits) = 0 AND p.email ILIKE v_like)
  ORDER BY 5, p.full_name NULLS LAST, p.id
  LIMIT v_limit OFFSET v_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cto_search_profiles(text, integer, integer) TO authenticated;