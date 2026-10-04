CREATE OR REPLACE FUNCTION public.search_invitable_subagents(
  search_term text DEFAULT ''::text,
  result_limit integer DEFAULT 15
)
RETURNS TABLE(id uuid, full_name text, phone text, email text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_term text := btrim(coalesce(search_term, ''));
  v_digits text := regexp_replace(coalesce(search_term, ''), '\D', '', 'g');
BEGIN
  -- Only signed-in agents may search for users to invite.
  IF auth.uid() IS NULL OR NOT has_role(auth.uid(), 'agent') THEN
    RETURN;
  END IF;

  IF length(v_term) < 2 THEN
    RETURN;
  END IF;

  IF length(v_digits) >= 3 THEN
    RETURN QUERY
      SELECT p.id, p.full_name, p.phone, p.email
      FROM public.profiles p
      WHERE p.id <> auth.uid()
        AND p.phone ILIKE '%' || right(v_digits, 9) || '%'
      ORDER BY p.full_name NULLS LAST
      LIMIT result_limit;
  ELSE
    RETURN QUERY
      SELECT p.id, p.full_name, p.phone, p.email
      FROM public.profiles p
      WHERE p.id <> auth.uid()
        AND (p.full_name ILIKE '%' || v_term || '%' OR p.email ILIKE '%' || v_term || '%')
      ORDER BY p.full_name NULLS LAST
      LIMIT result_limit;
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.search_invitable_subagents(text, integer) TO authenticated;