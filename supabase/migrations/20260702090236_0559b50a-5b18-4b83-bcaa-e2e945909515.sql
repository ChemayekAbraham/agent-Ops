CREATE OR REPLACE FUNCTION public.get_user_ids_by_phone(phone_variants text[])
RETURNS TABLE(user_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  last9_variants text[] := ARRAY[]::text[];
  v text;
  cleaned text;
BEGIN
  FOREACH v IN ARRAY phone_variants LOOP
    cleaned := regexp_replace(COALESCE(v, ''), '[^0-9]', '', 'g');
    IF length(cleaned) >= 9 THEN
      last9_variants := array_append(last9_variants, right(cleaned, 9));
    END IF;
  END LOOP;

  RETURN QUERY
  SELECT DISTINCT p.id
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE (
      right(regexp_replace(COALESCE(p.phone, ''), '[^0-9]', '', 'g'), 9) = ANY(last9_variants)
      OR right(regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g'), 9) = ANY(last9_variants)
    )
    AND COALESCE(p.full_name, '') NOT ILIKE '[ARCHIVED]%'
    AND (u.id IS NULL OR u.deleted_at IS NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.get_user_ids_by_phone(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_ids_by_phone(text[]) TO service_role;