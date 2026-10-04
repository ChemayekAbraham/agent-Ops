
CREATE OR REPLACE FUNCTION public.inspect_account_conflicts(
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_national_id text DEFAULT NULL
)
RETURNS TABLE (
  user_id uuid,
  full_name text,
  profile_phone text,
  profile_email text,
  profile_national_id text,
  tenant_status text,
  is_archived boolean,
  auth_email text,
  auth_phone text,
  auth_deleted_at timestamptz,
  auth_last_sign_in_at timestamptz,
  match_reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_is_mgr boolean;
  v_phone_last9 text;
  v_email_norm text;
  v_nid text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = v_caller AND role = 'manager' AND enabled = TRUE
  ) INTO v_is_mgr;
  IF NOT v_is_mgr THEN
    RAISE EXCEPTION 'Forbidden: manager role required' USING ERRCODE = '42501';
  END IF;

  v_phone_last9 := CASE WHEN p_phone IS NOT NULL AND p_phone <> ''
                        THEN normalize_phone_last9(p_phone) END;
  v_email_norm := CASE WHEN p_email IS NOT NULL AND p_email <> ''
                       THEN lower(trim(p_email)) END;
  v_nid := CASE WHEN p_national_id IS NOT NULL AND p_national_id <> ''
                THEN trim(p_national_id) END;

  RETURN QUERY
  WITH matches AS (
    SELECT pr.id,
           CASE
             WHEN v_phone_last9 IS NOT NULL AND normalize_phone_last9(pr.phone) = v_phone_last9 THEN 'phone'
             WHEN v_email_norm IS NOT NULL AND lower(pr.email) = v_email_norm THEN 'email'
             WHEN v_nid IS NOT NULL AND pr.national_id = v_nid THEN 'national_id'
           END AS reason
    FROM public.profiles pr
    WHERE
      (v_phone_last9 IS NOT NULL AND normalize_phone_last9(pr.phone) = v_phone_last9)
      OR (v_email_norm IS NOT NULL AND lower(pr.email) = v_email_norm)
      OR (v_nid IS NOT NULL AND pr.national_id = v_nid)
  )
  SELECT pr.id,
         pr.full_name,
         pr.phone,
         pr.email,
         pr.national_id,
         pr.tenant_status,
         (COALESCE(pr.full_name,'') ILIKE '[ARCHIVED]%' OR au.deleted_at IS NOT NULL) AS is_archived,
         au.email::text,
         au.phone::text,
         au.deleted_at,
         au.last_sign_in_at,
         m.reason
  FROM matches m
  JOIN public.profiles pr ON pr.id = m.id
  LEFT JOIN auth.users au ON au.id = pr.id
  ORDER BY (au.deleted_at IS NOT NULL) DESC, au.last_sign_in_at DESC NULLS LAST;
END;
$$;

GRANT EXECUTE ON FUNCTION public.inspect_account_conflicts(text, text, text) TO authenticated;
