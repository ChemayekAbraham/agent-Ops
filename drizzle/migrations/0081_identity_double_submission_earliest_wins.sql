-- One ID / one phone: the EARLIEST account always wins, even if Financial Ops
-- already verified a later account. Previously an existing verified account was
-- preferred as the holder.
CREATE OR REPLACE FUNCTION public.identity_double_submission(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nid text;
  v_phone text;
  v_first uuid;
  v_kind text;
  v_name text;
  v_first_phone text;
  v_first_nid text;
  v_created timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('is_double', false);
  END IF;

  SELECT public.normalize_national_id_fuzzy(p.national_id),
         right(regexp_replace(coalesce(p.phone,''), '[^0-9]', '', 'g'), 9)
    INTO v_nid, v_phone
  FROM public.profiles p
  WHERE p.id = p_user_id;

  IF length(coalesce(v_nid,'')) >= 6 THEN
    SELECT p.id INTO v_first
    FROM public.profiles p
    WHERE public.normalize_national_id_fuzzy(p.national_id) = v_nid
    ORDER BY p.created_at ASC NULLS LAST, p.id ASC
    LIMIT 1;
    IF v_first IS NOT NULL AND v_first <> p_user_id THEN
      v_kind := 'national_id';
    END IF;
  END IF;

  IF v_kind IS NULL AND length(coalesce(v_phone,'')) >= 9 THEN
    v_first := NULL;
    SELECT p.id INTO v_first
    FROM public.profiles p
    WHERE right(regexp_replace(coalesce(p.phone,''), '[^0-9]', '', 'g'), 9) = v_phone
    ORDER BY p.created_at ASC NULLS LAST, p.id ASC
    LIMIT 1;
    IF v_first IS NOT NULL AND v_first <> p_user_id THEN
      v_kind := 'phone';
    END IF;
  END IF;

  IF v_kind IS NULL THEN
    RETURN jsonb_build_object('is_double', false);
  END IF;

  SELECT p.full_name, p.phone, p.national_id, p.created_at
    INTO v_name, v_first_phone, v_first_nid, v_created
  FROM public.profiles p WHERE p.id = v_first;

  RETURN jsonb_build_object(
    'is_double', true,
    'kind', v_kind,
    'first_user_id', v_first,
    'first_name', v_name,
    'first_phone', v_first_phone,
    'first_national_id', v_first_nid,
    'first_created_at', v_created
  );
END;
$$;
