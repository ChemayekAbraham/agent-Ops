CREATE OR REPLACE FUNCTION public.national_id_group_view()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_nin text;
  v_fuzzy text;
  v_owner uuid;
  v_masked text;
  v_members jsonb := '[]'::jsonb;
  v_owner_row jsonb;
BEGIN
  IF v_me IS NULL THEN
    RETURN jsonb_build_object('found', false, 'reason', 'not_signed_in');
  END IF;

  SELECT nullif(coalesce(nullif(p.national_id, ''), nullif(p.linked_national_id, '')), '')
    INTO v_nin
  FROM public.profiles p
  WHERE p.id = v_me;

  IF v_nin IS NULL THEN
    RETURN jsonb_build_object('found', false, 'reason', 'no_national_id');
  END IF;

  v_fuzzy := public.normalize_national_id_fuzzy(v_nin);
  v_masked := public.mask_national_id(v_nin);

  -- Owner: earliest account that carries this ID as its own.
  SELECT p.id INTO v_owner
  FROM public.profiles p
  WHERE coalesce(p.national_id, '') <> ''
    AND public.normalize_national_id_fuzzy(p.national_id) = v_fuzzy
  ORDER BY p.created_at ASC NULLS LAST, p.id ASC
  LIMIT 1;

  IF v_owner IS NULL THEN
    SELECT p.id INTO v_owner
    FROM public.profiles p
    WHERE public.normalize_national_id_fuzzy(coalesce(p.national_id, '')) = v_fuzzy
       OR public.normalize_national_id_fuzzy(coalesce(p.linked_national_id, '')) = v_fuzzy
    ORDER BY p.created_at ASC NULLS LAST, p.id ASC
    LIMIT 1;
  END IF;

  IF v_owner = v_me THEN
    -- Members: any OTHER account carrying this ID in EITHER column. The previous
    -- coalesce(national_id, linked_national_id) preferred a member's own ID and
    -- hid everyone who had both, so linked members never appeared.
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'user_id', p.id,
             'full_name', p.full_name,
             'phone', p.phone,
             'email', p.email,
             'avatar_url', p.avatar_url
           ) ORDER BY p.created_at ASC NULLS LAST), '[]'::jsonb)
      INTO v_members
    FROM public.profiles p
    WHERE p.id <> v_me
      AND (public.normalize_national_id_fuzzy(coalesce(p.national_id, '')) = v_fuzzy
        OR public.normalize_national_id_fuzzy(coalesce(p.linked_national_id, '')) = v_fuzzy);

    RETURN jsonb_build_object(
      'found', true,
      'is_owner', true,
      'masked_nin', v_masked,
      'member_count', jsonb_array_length(v_members),
      'members', v_members,
      'owner', NULL
    );
  END IF;

  SELECT jsonb_build_object('user_id', p.id, 'full_name', p.full_name, 'phone', p.phone)
    INTO v_owner_row
  FROM public.profiles p
  WHERE p.id = v_owner;

  RETURN jsonb_build_object(
    'found', true,
    'is_owner', false,
    'masked_nin', v_masked,
    'member_count', 0,
    'members', '[]'::jsonb,
    'owner', v_owner_row
  );
END;
$function$;