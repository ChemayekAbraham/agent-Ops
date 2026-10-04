CREATE OR REPLACE FUNCTION public.submit_national_id_details(p_surname text, p_given_name text, p_nin text, p_date_of_birth date, p_card_number text, p_sex text, p_reading jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_surname text := upper(btrim(coalesce(p_surname,'')));
  v_given   text := upper(btrim(coalesce(p_given_name,'')));
  v_nin     text := upper(regexp_replace(coalesce(p_nin,''), '[^A-Za-z0-9]', '', 'g'));
  v_card    text := regexp_replace(coalesce(p_card_number,''), '[^0-9]', '', 'g');
  v_sex     text := upper(btrim(coalesce(p_sex,'')));
  v_name    text;
  v_taken   uuid;
  v_link    uuid;
  v_linked  boolean := false;
  v_ocr     jsonb := coalesce(p_reading->'data', '{}'::jsonb);
  v_edited  text[] := '{}';
  v_reading_id uuid;
  v_hint    jsonb;
  v_twins   jsonb;
  v_name_key text;
  v_name_owner uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Please sign in again.');
  END IF;

  IF v_surname !~ '^[A-Z][A-Z ''-]{1,39}$' THEN
    RETURN jsonb_build_object('success', false, 'field', 'surname',
      'message', 'Enter the surname exactly as printed on the card.');
  END IF;
  IF v_given !~ '^[A-Z][A-Z ''-]{1,39}$' THEN
    RETURN jsonb_build_object('success', false, 'field', 'given_name',
      'message', 'Enter the given name exactly as printed on the card.');
  END IF;
  IF v_nin !~ '^[A-Z0-9]{12,16}$' THEN
    RETURN jsonb_build_object('success', false, 'field', 'nin',
      'message', 'A NIN is 12 to 16 letters and numbers, with no spaces.');
  END IF;
  IF p_date_of_birth IS NULL
     OR p_date_of_birth > current_date
     OR extract(year FROM p_date_of_birth) < 1900 THEN
    RETURN jsonb_build_object('success', false, 'field', 'date_of_birth',
      'message', 'Enter the date of birth printed on the card.');
  END IF;
  IF v_card !~ '^[0-9]{6,12}$' THEN
    RETURN jsonb_build_object('success', false, 'field', 'card_number',
      'message', 'The card number is the row of digits on the card.');
  END IF;
  IF v_sex NOT IN ('M','F') THEN
    RETURN jsonb_build_object('success', false, 'field', 'sex',
      'message', 'Sex must be M or F, as printed on the card.');
  END IF;

  SELECT public.duplicate_national_id_owner(v_uid, v_nin) INTO v_taken;
  IF v_taken IS NOT NULL THEN
    SELECT id INTO v_link FROM public.national_id_link_requests
     WHERE requester_id = v_uid AND status IN ('owner_approved','active')
       AND nin_fuzzy = public.normalize_national_id_fuzzy(v_nin)
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC
     LIMIT 1;
    IF v_link IS NULL THEN
      v_hint := public.national_id_holder_hint(v_nin);
      IF coalesce((v_hint->>'limit_reached')::boolean, false) THEN
        RETURN jsonb_build_object('success', false, 'duplicate', true, 'full', true,
          'field', 'nin', 'accounts_on_id', v_hint->'accounts_on_id',
          'message', 'This National ID has reached its limit of 20 accounts. No more accounts can be added to it.');
      END IF;
      RETURN jsonb_build_object('success', false, 'duplicate', true, 'field', 'nin',
        'holder_first_name', v_hint->>'holder_first_name',
        'accounts_on_id', v_hint->'accounts_on_id',
        'message', CASE
          WHEN nullif(v_hint->>'holder_first_name', '') IS NOT NULL
            THEN 'This National ID is already on ' || (v_hint->>'holder_first_name') ||
                 '''s Welile account. You can be added under ' || (v_hint->>'holder_first_name') ||
                 ', but they must agree first.'
          ELSE 'This National ID is already recorded on another account. Ask the person who holds it to confirm you.'
        END);
    END IF;
    v_linked := true;
  END IF;

  v_name := btrim(v_given || ' ' || v_surname);

  -- The printed names on somebody else's card cannot be adopted here. If these
  -- exact names already sit on another account's National ID, and that account's
  -- ID number is not the one being submitted, this is a copied name: refuse it.
  v_name_key := public.person_name_key(v_name);
  IF v_name_key IS NOT NULL AND position(' ' IN v_name_key) > 0 THEN
    SELECT p.id INTO v_name_owner
      FROM public.profiles p
     WHERE p.id IS DISTINCT FROM v_uid
       AND public.person_name_key(coalesce(nullif(btrim(p.national_id_name), ''), p.full_name)) = v_name_key
       AND public.normalize_national_id_fuzzy(coalesce(p.national_id, '')) IS DISTINCT FROM public.normalize_national_id_fuzzy(v_nin)
       AND nullif(btrim(coalesce(p.national_id, '')), '') IS NOT NULL
     ORDER BY p.created_at
     LIMIT 1;

    IF v_name_owner IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'field', 'surname', 'name_taken', true,
        'message', 'These names are already taken on another Welile account holding a different National ID. '
                || 'Please enter your own real names exactly as printed on your own card to continue.');
    END IF;
  END IF;

  -- Linking an ID that is already recorded: the names typed must match the
  -- names already held on that ID. Anything else is refused, so a linked
  -- account can never overwrite or diverge from the existing holder's names.
  IF v_linked AND v_name_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id IS DISTINCT FROM v_uid
         AND public.normalize_national_id_fuzzy(coalesce(p.national_id, '')) = public.normalize_national_id_fuzzy(v_nin)
         AND public.person_name_key(coalesce(nullif(btrim(p.national_id_name), ''), p.full_name)) IS NOT NULL
         AND public.person_name_key(coalesce(nullif(btrim(p.national_id_name), ''), p.full_name)) <> v_name_key
    ) THEN
      RETURN jsonb_build_object('success', false, 'field', 'surname', 'name_mismatch', true,
        'message', 'The names must match the names already recorded on this National ID. Type them exactly as printed on the card.');
    END IF;
  END IF;

  IF coalesce(v_ocr->>'surname','')       IS DISTINCT FROM v_surname THEN v_edited := v_edited || 'surname'::text; END IF;
  IF coalesce(v_ocr->>'given_name','')    IS DISTINCT FROM v_given   THEN v_edited := v_edited || 'given_name'::text; END IF;
  IF coalesce(v_ocr->>'nin','')           IS DISTINCT FROM v_nin     THEN v_edited := v_edited || 'nin'::text; END IF;
  IF coalesce(v_ocr->>'date_of_birth','') IS DISTINCT FROM to_char(p_date_of_birth,'YYYY-MM-DD') THEN v_edited := v_edited || 'date_of_birth'::text; END IF;
  IF coalesce(v_ocr->>'card_number','')   IS DISTINCT FROM v_card    THEN v_edited := v_edited || 'card_number'::text; END IF;
  IF coalesce(v_ocr->>'sex','')           IS DISTINCT FROM v_sex     THEN v_edited := v_edited || 'sex'::text; END IF;

  BEGIN
    IF v_linked THEN
      UPDATE public.profiles
         SET linked_national_id       = v_nin,
             linked_national_id_request_id = v_link,
             national_id_name         = v_name,
             national_id_surname      = v_surname,
             national_id_given_name   = v_given,
             national_id_card_number  = v_card,
             date_of_birth            = p_date_of_birth,
             sex                      = v_sex
       WHERE id = v_uid;
    ELSE
      UPDATE public.profiles
         SET national_id              = v_nin,
             national_id_name         = v_name,
             national_id_surname      = v_surname,
             national_id_given_name   = v_given,
             national_id_card_number  = v_card,
             date_of_birth            = p_date_of_birth,
             sex                      = v_sex
       WHERE id = v_uid;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'duplicate', true, 'field', 'nin',
      'message', 'This National ID is already recorded on another account.');
  END;

  UPDATE public.payout_destination_verifications d
     SET national_id = v_nin,
         national_id_name = v_name,
         national_id_submitted_at = now(),
         name_match_score = (public.payout_name_match_report(v_name, d.account_name)->>'score')::numeric,
         name_mismatch_tokens = coalesce(public.payout_name_match_report(v_name, d.account_name)->'diff', '[]'::jsonb)
   WHERE d.user_id = v_uid;

  v_twins := public.national_id_name_twins(v_uid, v_name);

  INSERT INTO public.national_id_readings (
    user_id, sha256, status, confidence, ocr, field_verdicts, missing, consistency,
    confirmed, edited_fields, face_verified
  ) VALUES (
    v_uid,
    nullif(p_reading->>'sha256',''),
    nullif(p_reading->>'status',''),
    nullif(p_reading->>'confidence','')::numeric,
    v_ocr,
    coalesce(p_reading->'fields', '{}'::jsonb),
    coalesce((SELECT array_agg(x::text) FROM jsonb_array_elements_text(coalesce(p_reading->'missing','[]'::jsonb)) x), '{}'),
    coalesce(p_reading->'consistency', '[]'::jsonb),
    jsonb_build_object('surname', v_surname, 'given_name', v_given, 'nin', v_nin,
                       'date_of_birth', to_char(p_date_of_birth,'YYYY-MM-DD'),
                       'card_number', v_card, 'sex', v_sex),
    v_edited,
    CASE WHEN p_reading ? 'face_verified' THEN (p_reading->>'face_verified')::boolean END
  ) RETURNING id INTO v_reading_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (v_uid, 'national_id_details_submitted', 'profiles', v_uid::text,
          'Account holder confirmed the details read from their National ID.',
          jsonb_build_object('reading_id', v_reading_id,
                             'status', p_reading->>'status',
                             'linked_group', v_linked,
                             'edited_fields', to_jsonb(v_edited),
                             'same_name_accounts', v_twins->'count',
                             'name_key', v_twins->>'name_key'));

  RETURN jsonb_build_object(
    'success', true,
    'reading_id', v_reading_id,
    'linked', v_linked,
    'edited_fields', to_jsonb(v_edited),
    'full_name', v_name,
    'same_name_accounts', v_twins->'count',
    'message', 'National ID details saved.');
END;
$fn$;