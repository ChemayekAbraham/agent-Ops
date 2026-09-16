-- National ID FIFO hardening.
--
-- 1) Duplicate detection now compares National ID numbers with the SAME fuzzy
--    normalisation used for link requests, so a lookalike reading (O for 0,
--    I/L for 1, S for 5, B for 8, Z for 2) can no longer register a second
--    primary copy of an ID that another account already holds.
-- 2) The person who typed the ID is told the FIRST NAME of the account that
--    already holds it, and nothing else about that account.
-- 3) Name inheritance is deterministic: only the account that holds the ID in
--    its own national_id column takes the name from the ID. Linked accounts
--    always keep (and may edit) their own name.
-- 4) Same-person name detection across word order (First+Last, Last+First,
--    any order of the words) is exposed for staff review, never blocking.

CREATE OR REPLACE FUNCTION public.person_name_key(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT nullif(
    (SELECT string_agg(w, ' ' ORDER BY w)
       FROM regexp_split_to_table(
              btrim(regexp_replace(upper(coalesce(p_name, '')), '[^A-Z]+', ' ', 'g')),
              '\s+') AS w
      WHERE length(w) > 1),
    '');
$$;

CREATE OR REPLACE FUNCTION public.duplicate_national_id_owner(p_user_id uuid, p_national_id text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_strict text := upper(regexp_replace(coalesce(p_national_id, ''), '[^A-Za-z0-9]', '', 'g'));
  v_fuzzy  text := public.normalize_national_id_fuzzy(p_national_id);
  v_owner  uuid;
BEGIN
  IF length(v_strict) < 6 THEN
    RETURN NULL;
  END IF;

  SELECT p.id INTO v_owner
  FROM public.profiles p
  WHERE p.id IS DISTINCT FROM p_user_id
    AND coalesce(p.national_id, '') <> ''
    AND public.normalize_national_id_fuzzy(p.national_id) = v_fuzzy
  ORDER BY p.created_at ASC NULLS LAST, p.id ASC
  LIMIT 1;

  IF v_owner IS NOT NULL THEN
    RETURN v_owner;
  END IF;

  SELECT d.user_id INTO v_owner
  FROM public.payout_destination_verifications d
  WHERE d.user_id IS DISTINCT FROM p_user_id
    AND d.status = 'verified'
    AND coalesce(d.national_id, '') <> ''
    AND public.normalize_national_id_fuzzy(d.national_id) = v_fuzzy
  ORDER BY d.created_at ASC NULLS LAST
  LIMIT 1;

  RETURN v_owner;
END;
$$;

CREATE OR REPLACE FUNCTION public.national_id_holder_hint(p_nin text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_fuzzy  text := public.normalize_national_id_fuzzy(p_nin);
  v_holder uuid;
  v_name   text;
  v_first  text;
  v_active int;
BEGIN
  IF v_uid IS NULL OR length(coalesce(v_fuzzy, '')) < 6 THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT public.duplicate_national_id_owner(v_uid, p_nin) INTO v_holder;
  IF v_holder IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT coalesce(nullif(btrim(coalesce(p.national_id_given_name, '')), ''),
                  nullif(btrim(coalesce(p.national_id_name, '')), ''),
                  nullif(btrim(coalesce(p.full_name, '')), ''))
    INTO v_name
  FROM public.profiles p WHERE p.id = v_holder;

  v_first := split_part(btrim(coalesce(v_name, '')), ' ', 1);

  SELECT 1 + count(*) INTO v_active
  FROM public.national_id_link_requests
  WHERE nin_fuzzy = v_fuzzy AND status = 'active';

  RETURN jsonb_build_object(
    'found', true,
    'holder_first_name', nullif(initcap(lower(v_first)), ''),
    'accounts_on_id', v_active,
    'limit_reached', v_active >= 20);
END;
$$;

CREATE OR REPLACE FUNCTION public.national_id_name_twins(p_user_id uuid, p_name text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text := public.person_name_key(p_name);
  v_cnt int;
  v_sample jsonb;
BEGIN
  IF v_key IS NULL OR position(' ' IN v_key) = 0 THEN
    RETURN jsonb_build_object('count', 0, 'name_key', v_key);
  END IF;

  SELECT count(*), coalesce(jsonb_agg(x.nm ORDER BY x.nm), '[]'::jsonb)
    INTO v_cnt, v_sample
  FROM (
    SELECT coalesce(nullif(btrim(p.national_id_name), ''), p.full_name) AS nm
    FROM public.profiles p
    WHERE p.id IS DISTINCT FROM p_user_id
      AND (public.person_name_key(p.full_name) = v_key
           OR public.person_name_key(p.national_id_name) = v_key)
    LIMIT 25
  ) x;

  RETURN jsonb_build_object('count', v_cnt, 'name_key', v_key, 'names', v_sample);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_national_id_details(
  p_surname text, p_given_name text, p_nin text, p_date_of_birth date,
  p_card_number text, p_sex text, p_reading jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

CREATE OR REPLACE FUNCTION public.request_national_id_link(p_nin text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_nin text := upper(regexp_replace(coalesce(p_nin,''), '[^A-Za-z0-9]', '', 'g'));
  v_fuzzy text;
  v_holder uuid;
  v_existing public.national_id_link_requests;
  v_count int;
  v_id uuid;
  v_hint jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Please sign in again.');
  END IF;
  IF v_nin !~ '^[A-Z0-9]{12,16}$' THEN
    RETURN jsonb_build_object('success', false, 'message', 'A NIN is 12 to 16 letters and numbers.');
  END IF;

  PERFORM public.national_id_link_expire_stale();

  v_fuzzy := public.normalize_national_id_fuzzy(v_nin);
  SELECT public.duplicate_national_id_owner(v_uid, v_nin) INTO v_holder;
  IF v_holder IS NULL THEN
    RETURN jsonb_build_object('success', false, 'no_holder', true,
      'message', 'That National ID is not recorded on another account.');
  END IF;

  v_hint := public.national_id_holder_hint(v_nin);

  SELECT * INTO v_existing FROM public.national_id_link_requests
   WHERE requester_id = v_uid AND nin_fuzzy = v_fuzzy
     AND status IN ('awaiting_owner','owner_approved','active')
   ORDER BY created_at DESC LIMIT 1;
  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'request_id', v_existing.id,
      'status', v_existing.status, 'nin', v_existing.nin, 'reused', true,
      'holder_first_name', v_hint->>'holder_first_name',
      'accounts_on_id', v_hint->'accounts_on_id');
  END IF;

  SELECT 1 + count(*) INTO v_count
    FROM public.national_id_link_requests
   WHERE nin_fuzzy = v_fuzzy AND status = 'active';
  IF v_count >= 20 THEN
    RETURN jsonb_build_object('success', false, 'full', true, 'accounts_on_id', v_count,
      'message', 'This National ID has reached its limit of 20 accounts. No more accounts can be added to it.');
  END IF;

  INSERT INTO public.national_id_link_requests (requester_id, holder_id, nin, nin_fuzzy)
  VALUES (v_uid, v_holder, v_nin, v_fuzzy)
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (v_uid, 'national_id_link_requested', 'national_id_link_requests', v_id::text,
          'Account asked to be linked to a National ID already recorded on another account.',
          jsonb_build_object('holder_id', v_holder, 'nin', v_nin));

  RETURN jsonb_build_object('success', true, 'request_id', v_id,
    'status', 'awaiting_owner', 'nin', v_nin,
    'holder_first_name', v_hint->>'holder_first_name',
    'accounts_on_id', v_hint->'accounts_on_id');
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_identity_binding(
  p_ip_address text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_p record;
  v_num text;
  v_name text;
  v_prov text;
  v_id uuid;
  v_existing record;
  v_idname text;
  v_nin text;
  v_name_from_id boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;

  SELECT id, full_name, national_id, linked_national_id, national_id_name,
         national_id_surname, national_id_given_name, national_id_card_number,
         date_of_birth, sex, national_id_photo_path, national_id_back_photo_path,
         selfie_photo_path, mobile_money_number, mobile_money_name, mobile_money_provider
    INTO v_p
  FROM public.profiles WHERE id = v_uid;

  SELECT * INTO v_existing FROM public.user_identity_bindings WHERE user_id = v_uid;
  IF v_existing.id IS NOT NULL AND v_existing.status <> 'revoked' THEN
    RETURN jsonb_build_object(
      'success', true, 'code', 'already_bound', 'binding_id', v_existing.id,
      'status', v_existing.status,
      'locked_payout_number', v_existing.locked_payout_number);
  END IF;

  IF coalesce(v_p.national_id, v_p.linked_national_id, '') = '' THEN
    RETURN jsonb_build_object('success', false, 'code', 'national_id_missing',
      'message', 'Add your National ID details first.');
  END IF;
  IF coalesce(v_p.national_id_photo_path, '') = '' THEN
    RETURN jsonb_build_object('success', false, 'code', 'id_photo_missing',
      'message', 'Take a photo of your National ID first.');
  END IF;
  IF coalesce(v_p.selfie_photo_path, '') = '' THEN
    RETURN jsonb_build_object('success', false, 'code', 'selfie_missing',
      'message', 'Take your selfie first.');
  END IF;

  SELECT d.momo_number,
         coalesce(nullif(btrim(d.final_name_override), ''), d.account_name),
         lower(coalesce(d.provider, ''))
    INTO v_num, v_name, v_prov
  FROM public.payout_destination_verifications d
  WHERE d.user_id = v_uid
    AND d.destination_type = 'mobile_money'
    AND d.ownership_code_confirmed_at IS NOT NULL
    AND coalesce(d.momo_number, '') <> ''
  ORDER BY d.ownership_code_confirmed_at ASC
  LIMIT 1;

  IF coalesce(v_num, '') = '' THEN
    v_num := v_p.mobile_money_number;
    v_name := v_p.mobile_money_name;
    v_prov := lower(coalesce(v_p.mobile_money_provider, ''));
  END IF;

  IF coalesce(v_num, '') = '' THEN
    RETURN jsonb_build_object('success', false, 'code', 'payout_number_missing',
      'message', 'Confirm your withdrawal number with the code sent to it first.');
  END IF;

  INSERT INTO public.user_identity_bindings (
    user_id, national_id, linked_national_id, full_legal_name,
    national_id_surname, national_id_given_name, date_of_birth, sex,
    national_id_card_number, national_id_photo_path, national_id_back_photo_path,
    selfie_photo_path, locked_payout_number, locked_payout_name, locked_payout_provider,
    status, ip_address, user_agent, capture_source
  ) VALUES (
    v_uid, v_p.national_id, v_p.linked_national_id,
    coalesce(nullif(btrim(coalesce(v_p.national_id_name, '')), ''), v_p.full_name),
    v_p.national_id_surname, v_p.national_id_given_name, v_p.date_of_birth, v_p.sex,
    v_p.national_id_card_number, v_p.national_id_photo_path, v_p.national_id_back_photo_path,
    v_p.selfie_photo_path, v_num, v_name, nullif(v_prov, ''),
    'identity_captured', nullif(btrim(coalesce(p_ip_address, '')), ''),
    nullif(btrim(coalesce(p_user_agent, '')), ''), 'user_capture'
  )
  ON CONFLICT (user_id) DO UPDATE SET
    national_id = coalesce(public.user_identity_bindings.national_id, EXCLUDED.national_id),
    linked_national_id = coalesce(public.user_identity_bindings.linked_national_id, EXCLUDED.linked_national_id),
    locked_payout_number = coalesce(public.user_identity_bindings.locked_payout_number, EXCLUDED.locked_payout_number),
    locked_payout_name = coalesce(public.user_identity_bindings.locked_payout_name, EXCLUDED.locked_payout_name),
    locked_payout_provider = coalesce(public.user_identity_bindings.locked_payout_provider, EXCLUDED.locked_payout_provider),
    status = 'identity_captured'
  RETURNING id INTO v_id;

  UPDATE public.payout_destination_verifications d
  SET status = 'verified',
      decision_reason = coalesce(nullif(btrim(d.decision_reason), ''),
        'Identity captured and permanently bound to this account; withdrawal number locked.'),
      decided_at = coalesce(d.decided_at, now()),
      call_outcome = coalesce(d.call_outcome, 'identity_captured'),
      updated_at = now()
  WHERE d.user_id = v_uid
    AND d.status = 'waiting'
    AND d.destination_type = 'mobile_money'
    AND right(regexp_replace(coalesce(d.momo_number, ''), '\D', '', 'g'), 9)
        = right(regexp_replace(v_num, '\D', '', 'g'), 9);

  -- FIFO name inheritance, decided by ownership rather than by timing: only the
  -- account that holds the ID in its OWN national_id column takes its displayed
  -- name from the ID (the unique index guarantees exactly one such account).
  -- Every later account on the same ID is a linked account and keeps -- and may
  -- freely edit -- its own name, because the ID name is already carried.
  v_idname := nullif(btrim(coalesce(
      nullif(btrim(coalesce(v_p.national_id_name, '')), ''),
      nullif(btrim(coalesce(v_p.national_id_surname, '') || ' ' || coalesce(v_p.national_id_given_name, '')), '')
    )), '');
  v_nin := public.normalize_national_id_fuzzy(v_p.national_id);

  IF v_idname IS NOT NULL AND coalesce(v_nin, '') <> ''
     AND coalesce(btrim(coalesce(v_p.national_id, '')), '') <> '' THEN
    UPDATE public.profiles
       SET full_name = v_idname, updated_at = now()
     WHERE id = v_uid
       AND coalesce(btrim(full_name), '') <> v_idname;
    v_name_from_id := true;
  END IF;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, ip_address, user_agent, metadata)
    VALUES
      (v_uid, 'IDENTITY_CAPTURED', 'user_identity_bindings', v_id,
       nullif(btrim(coalesce(p_ip_address, '')), ''), nullif(btrim(coalesce(p_user_agent, '')), ''),
       jsonb_build_object('reason', 'Identity information captured and bound to the account.',
                          'name_from_national_id', v_name_from_id)),
      (v_uid, 'WITHDRAWAL_NUMBER_LOCKED', 'user_identity_bindings', v_id,
       nullif(btrim(coalesce(p_ip_address, '')), ''), nullif(btrim(coalesce(p_user_agent, '')), ''),
       jsonb_build_object('locked_number_last4', right(regexp_replace(v_num, '\D', '', 'g'), 4),
                          'reason', 'Withdrawal number locked to the captured identity.'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('success', true, 'code', 'identity_captured',
    'binding_id', v_id, 'status', 'identity_captured', 'locked_payout_number', v_num,
    'name_from_national_id', v_name_from_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.person_name_key(text) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.national_id_holder_hint(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.national_id_name_twins(uuid, text) TO authenticated, service_role;
