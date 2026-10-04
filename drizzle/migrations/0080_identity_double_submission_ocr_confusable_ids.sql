-- Normalize National IDs so OCR-confusable characters (O/0, I/1, L/1, S/5, B/8, Z/2)
-- collapse to one value. Fixes cases where the same physical ID was captured as
-- CM0202610C8AEJ on one account and CMO202610C8AEJ on another, escaping the
-- one-ID-one-account rule.
CREATE OR REPLACE FUNCTION public.normalize_national_id_fuzzy(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT translate(
           upper(regexp_replace(coalesce(p_value,''), '[^A-Za-z0-9]', '', 'g')),
           'OILSBZ', '011582'
         );
$$;

CREATE INDEX IF NOT EXISTS profiles_national_id_fuzzy_idx
  ON public.profiles (public.normalize_national_id_fuzzy(national_id));

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
    ORDER BY (EXISTS (SELECT 1 FROM public.payout_destination_verifications d
                      WHERE d.user_id = p.id AND d.status = 'verified')) DESC,
             p.created_at ASC NULLS LAST, p.id ASC
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
    ORDER BY (EXISTS (SELECT 1 FROM public.payout_destination_verifications d
                      WHERE d.user_id = p.id AND d.status = 'verified')) DESC,
             p.created_at ASC NULLS LAST, p.id ASC
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
