CREATE OR REPLACE FUNCTION public.auth_user_ids_by_phone_last9(p_last9 text)
RETURNS TABLE(user_id uuid, auth_phone text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id, u.phone
  FROM auth.users u
  WHERE p_last9 IS NOT NULL
    AND length(regexp_replace(p_last9, '\D', '', 'g')) = 9
    AND u.phone IS NOT NULL
    AND right(regexp_replace(u.phone, '\D', '', 'g'), 9) = right(regexp_replace(p_last9, '\D', '', 'g'), 9);
$$;

REVOKE ALL ON FUNCTION public.auth_user_ids_by_phone_last9(text) FROM public;
REVOKE ALL ON FUNCTION public.auth_user_ids_by_phone_last9(text) FROM anon;
REVOKE ALL ON FUNCTION public.auth_user_ids_by_phone_last9(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.auth_user_ids_by_phone_last9(text) TO service_role;