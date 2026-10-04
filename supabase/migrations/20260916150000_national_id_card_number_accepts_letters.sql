-- New NIRA National ID cards print an alphanumeric card number
-- (e.g. "CA144787388" - 2 letters + 9 digits), not the all-digit number on
-- older cards. submit_national_id_details() stripped everything but digits
-- and rejected anything outside ^[0-9]{6,12}$, so a new-format card number
-- could never be saved. Widen normalisation and validation to accept
-- uppercase letters and digits, still requiring at least one digit so a
-- garbage all-letter value is still rejected.

CREATE OR REPLACE FUNCTION public.submit_national_id_details(
  p_surname text, p_given_name text, p_nin text, p_date_of_birth date,
  p_card_number text, p_sex text, p_reading jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_surname text := upper(btrim(coalesce(p_surname,'')));
  v_given   text := upper(btrim(coalesce(p_given_name,'')));
  v_nin     text := upper(regexp_replace(coalesce(p_nin,''), '[^A-Za-z0-9]', '', 'g'));
  v_card    text := upper(regexp_replace(coalesce(p_card_number,''), '[^A-Za-z0-9]', '', 'g'));
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
  IF v_card !~ '^[A-Z0-9]{6,14}$' OR v_card !~ '[0-9]' THEN
    RETURN jsonb_build_object('success', false, 'field', 'card_number',
      'message', 'The card number is the row of letters and numbers on the card.');
  END IF;
  IF v_sex NOT IN ('M','F') THEN
    RETURN jsonb_build_object('success', false, 'field', 'sex',
      'message', 'Sex must be M or F, as printed on the card.');
  END IF;

  SELECT public.duplicate_national_id_owner(v_uid, v_nin) INTO v_taken;
  IF v_taken IS NOT NULL THEN
    SELECT id INTO v_link FROM public.national_id_link_requests
     WHERE requester_id = v_uid AND status = 'active'
       AND nin_fuzzy = public.normalize_national_id_fuzzy(v_nin)
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
$function$;

COMMENT ON COLUMN public.profiles.national_id_card_number IS
  'The CARD number printed on the National ID - changes when a card is reissued. Not the NIN. New NIRA cards print letters and digits (e.g. CA144787388); older cards are all-digit.';
