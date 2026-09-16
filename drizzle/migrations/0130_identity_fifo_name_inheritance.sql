CREATE OR REPLACE FUNCTION public.complete_identity_binding(p_ip_address text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_first uuid;
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

  -- The number must have been confirmed with the code sent to it.
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

  -- Capture alone opens withdrawals: the destination row stops being a manual gate.
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

  -- FIFO name inheritance: only the FIRST account holding a given National ID
  -- takes its displayed name from the ID. Later accounts on the same ID keep
  -- (and may freely edit) their own name, because the ID name is already carried.
  v_idname := nullif(btrim(coalesce(
      nullif(btrim(coalesce(v_p.national_id_name, '')), ''),
      nullif(btrim(coalesce(v_p.national_id_surname, '') || ' ' || coalesce(v_p.national_id_given_name, '')), '')
    )), '');
  v_nin := public.normalize_national_id_fuzzy(coalesce(v_p.national_id, v_p.linked_national_id));

  IF v_idname IS NOT NULL AND coalesce(v_nin, '') <> '' THEN
    SELECT b.user_id INTO v_first
    FROM public.user_identity_bindings b
    WHERE public.normalize_national_id_fuzzy(coalesce(b.national_id, b.linked_national_id)) = v_nin
      AND b.status <> 'revoked'
    ORDER BY coalesce(b.submitted_at, b.created_at) ASC, b.created_at ASC, b.user_id ASC
    LIMIT 1;

    IF v_first = v_uid THEN
      UPDATE public.profiles
         SET full_name = v_idname, updated_at = now()
       WHERE id = v_uid
         AND coalesce(btrim(full_name), '') <> v_idname;
      v_name_from_id := true;
    END IF;
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
$function$;