-- Let an account linked to someone else's National ID complete its identity
-- binding, and therefore withdraw.
--
-- THE CONTRADICTION
-- `complete_identity_binding` already accepts a LINKED id for the number:
--
--     IF coalesce(v_p.national_id, v_p.linked_national_id, '') = '' THEN reject
--
-- and then demands the person's OWN documents:
--
--     IF coalesce(v_p.national_id_photo_path, '') = '' THEN  'id_photo_missing'
--     IF coalesce(v_p.selfie_photo_path, '')      = '' THEN  'selfie_missing'
--
-- A linked account holds no card to photograph - the card belongs to the owner.
-- So the binding can never be created, and `payout_withdrawal_block_reasons`
-- blocks on exactly one condition: no binding row with a locked payout number.
-- The reasons it lists ("take a photo of your National ID", "take a selfie")
-- are unreachable for these accounts, and would not help even if done: that
-- branch returns blocked regardless of what the profile contains.
--
-- Four accounts are stuck in it today. Mukisa juli (+256707911662) is the one
-- that surfaced it.
--
-- THE DECISION (product owner, 2026-09-24): "linked parties must be able to
-- withdraw too."
--
-- WHAT THIS ALLOWS
-- When an account is missing its own ID photo or selfie but HAS a
-- linked_national_id, the binding may be completed using the ID OWNER's
-- captured documents, provided the owner is a real, already-verified account.
--
-- The test is DOCUMENTS, not the ID number. Hassan Hussein (+256745066410)
-- carries an own national_id of 'CMHUYDDR47G468' - malformed, letters where a
-- Ugandan NIN has digits - with nothing behind it, while linked to a real ID
-- whose owner is verified. Keying on the number would leave him blocked behind
-- documents for an ID that does not appear to exist. A typed number proves
-- nothing; the documents are the substance.
--
-- WHAT IT STILL REQUIRES, AND WHY
-- A linked account must have an OWNERSHIP-CONFIRMED payout number of its own -
-- one where `ownership_code_confirmed_at` is set, meaning a code was sent to
-- that number and entered back. The profile-level fallback that own-ID accounts
-- get is deliberately NOT extended to linked accounts.
--
-- The reason is concrete rather than theoretical. Of the four stuck accounts,
-- Hilary Evanz (+256756673744) has `mobile_money_number = 0779007902` - which
-- is the phone of JAMES KATONGOLE, the owner of the very ID he is linked to -
-- and has never confirmed ownership of it. Binding him on the profile fallback
-- would send his withdrawals to the ID owner. When the identity is borrowed,
-- the payout number is the ONLY thing tying the money to the person, so it has
-- to be proven rather than typed.
--
-- So this unblocks three of the four immediately and leaves Hilary with one
-- self-serve step that is genuinely his to do: confirm a number he controls.
--
-- THE OWNER MUST BE REAL AND ALREADY VERIFIED
--   * a profile must hold that ID in its OWN `national_id` column (the unique
--     index guarantees at most one such account);
--   * that owner must have a non-revoked binding of their own - the ID has
--     been captured and checked at least once;
--   * the owner's id photo and selfie must both exist, since they are what the
--     linked binding will carry.
-- Without these a linked account could bind against an ID nobody ever verified.
--
-- PROVENANCE IS RECORDED, NOT LAUNDERED
-- The binding stores the owner's document paths, so `capture_source` is set to
-- 'linked_id_owner' rather than 'user_capture', and the audit entry names the
-- owner. The record must never imply this person submitted documents they
-- never held.
--
-- NOT CHANGED: an account that has uploaded BOTH its own ID photo and selfie
-- still binds against its own documents, exactly as before. The linked path is
-- a fallback, never a preference.

DO $guard$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'complete_identity_binding';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'complete_identity_binding is missing';
  END IF;
  -- Restated below in full, so refuse if the live copy is not the one this was
  -- written against.
  IF position('id_photo_missing' in v_src) = 0
     OR position('FIFO name inheritance' in v_src) = 0
     OR position('WITHDRAWAL_NUMBER_LOCKED' in v_src) = 0 THEN
    RAISE EXCEPTION 'complete_identity_binding has drifted from the reviewed copy - inspect by hand';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.complete_identity_binding(
  p_ip_address text DEFAULT NULL,
  p_user_agent text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
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
  -- Linked-identity support.
  v_is_linked boolean := false;
  v_owner record;
  v_id_photo text;
  v_id_back text;
  v_selfie text;
  v_capture text := 'user_capture';
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

  -- Linked is decided by DOCUMENTS, not by whether a number was typed.
  --
  -- The first draft of this keyed on `national_id IS NULL`, and Hassan Hussein
  -- (+256745066410) showed why that is wrong: he carries an own national_id of
  -- 'CMHUYDDR47G468' - malformed, letters where a Ugandan NIN has digits - with
  -- no photo and no selfie behind it, while being linked to a real ID whose
  -- owner is fully verified. Keying on the number left him blocked behind
  -- documents for an ID that does not appear to exist.
  --
  -- A typed number proves nothing. The documents are the substance, so: if the
  -- account has its own ID photo and selfie it uses them, and otherwise falls
  -- back to the owner of the ID it is linked to.
  v_is_linked := (coalesce(btrim(coalesce(v_p.national_id_photo_path, '')), '') = ''
                  OR coalesce(btrim(coalesce(v_p.selfie_photo_path, '')), '') = '')
             AND nullif(btrim(coalesce(v_p.linked_national_id, '')), '') IS NOT NULL;

  IF v_is_linked THEN
    SELECT o.id, o.full_name, o.national_id_photo_path, o.national_id_back_photo_path,
           o.selfie_photo_path
      INTO v_owner
    FROM public.profiles o
    WHERE btrim(coalesce(o.national_id, '')) = btrim(v_p.linked_national_id)
    LIMIT 1;

    IF v_owner.id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'linked_owner_missing',
        'message', 'The National ID you are linked to is not registered to any account yet.');
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.user_identity_bindings b
       WHERE b.user_id = v_owner.id AND b.status <> 'revoked'
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'linked_owner_unverified',
        'message', 'The owner of that National ID has not completed their own identity check yet.');
    END IF;

    IF coalesce(btrim(coalesce(v_owner.national_id_photo_path, '')), '') = ''
       OR coalesce(btrim(coalesce(v_owner.selfie_photo_path, '')), '') = '' THEN
      RETURN jsonb_build_object('success', false, 'code', 'linked_owner_documents_missing',
        'message', 'The owner of that National ID has not uploaded their ID photo and selfie.');
    END IF;

    v_id_photo := v_owner.national_id_photo_path;
    v_id_back  := v_owner.national_id_back_photo_path;
    v_selfie   := v_owner.selfie_photo_path;
    v_capture  := 'linked_id_owner';
  ELSE
    IF coalesce(v_p.national_id_photo_path, '') = '' THEN
      RETURN jsonb_build_object('success', false, 'code', 'id_photo_missing',
        'message', 'Take a photo of your National ID first.');
    END IF;
    IF coalesce(v_p.selfie_photo_path, '') = '' THEN
      RETURN jsonb_build_object('success', false, 'code', 'selfie_missing',
        'message', 'Take your selfie first.');
    END IF;
    v_id_photo := v_p.national_id_photo_path;
    v_id_back  := v_p.national_id_back_photo_path;
    v_selfie   := v_p.selfie_photo_path;
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

  -- The profile fallback is for accounts binding their OWN ID. A linked account
  -- is borrowing an identity, so the payout number is the only thing tying the
  -- money to them: it must be proven with the ownership code, not typed in.
  IF coalesce(v_num, '') = '' AND NOT v_is_linked THEN
    v_num := v_p.mobile_money_number;
    v_name := v_p.mobile_money_name;
    v_prov := lower(coalesce(v_p.mobile_money_provider, ''));
  END IF;

  IF coalesce(v_num, '') = '' THEN
    RETURN jsonb_build_object('success', false, 'code', 'payout_number_missing',
      'message', CASE WHEN v_is_linked
        THEN 'Confirm the withdrawal number that belongs to YOU with the code we send to it. '
             || 'Because your account uses another person''s National ID, the number must be one you have proven you control.'
        ELSE 'Confirm your withdrawal number with the code sent to it first.' END);
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
    v_p.national_id_card_number, v_id_photo, v_id_back,
    v_selfie, v_num, v_name, nullif(v_prov, ''),
    'identity_captured', nullif(btrim(coalesce(p_ip_address, '')), ''),
    nullif(btrim(coalesce(p_user_agent, '')), ''), v_capture
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
                          'name_from_national_id', v_name_from_id,
                          'capture_source', v_capture,
                          -- Never let the record imply this person submitted
                          -- documents they never held.
                          'documents_from_id_owner', CASE WHEN v_is_linked THEN v_owner.id ELSE NULL END,
                          'documents_from_id_owner_name', CASE WHEN v_is_linked THEN v_owner.full_name ELSE NULL END)),
      (v_uid, 'WITHDRAWAL_NUMBER_LOCKED', 'user_identity_bindings', v_id,
       nullif(btrim(coalesce(p_ip_address, '')), ''), nullif(btrim(coalesce(p_user_agent, '')), ''),
       jsonb_build_object('locked_number_last4', right(regexp_replace(v_num, '\D', '', 'g'), 4),
                          'reason', 'Withdrawal number locked to the captured identity.',
                          'linked_identity', v_is_linked));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('success', true, 'code', 'identity_captured',
    'binding_id', v_id, 'status', 'identity_captured', 'locked_payout_number', v_num,
    'name_from_national_id', v_name_from_id,
    'linked_identity', v_is_linked);
END $fn$;


-- Backfill the accounts that already satisfy the new rule -----------------------
-- The UI only calls `complete_identity_binding` immediately after a payout
-- number is confirmed with its ownership code. The linked accounts stuck today
-- confirmed their number weeks ago, so without this they would have to re-do a
-- step they have already completed, purely to trigger a function whose answer
-- is already known.
--
-- This applies EXACTLY the rule the function now implements - verified owner,
-- owner documents present, the account's own payout number proven with the
-- ownership code - and nothing looser. An account that does not satisfy it is
-- not touched.
DO $backfill$
DECLARE r record; v_n int := 0;
BEGIN
  FOR r IN
    SELECT p.id AS user_id, p.full_name, p.national_id, p.linked_national_id,
           p.national_id_surname, p.national_id_given_name, p.date_of_birth, p.sex,
           p.national_id_card_number, p.national_id_name,
           o.id AS owner_id, o.full_name AS owner_name,
           o.national_id_photo_path, o.national_id_back_photo_path, o.selfie_photo_path,
           d.momo_number,
           COALESCE(NULLIF(btrim(d.final_name_override), ''), d.account_name) AS payout_name,
           lower(COALESCE(d.provider, '')) AS payout_provider
      FROM public.profiles p
      JOIN public.profiles o
        ON btrim(COALESCE(o.national_id, '')) = btrim(p.linked_national_id)
      JOIN LATERAL (
        SELECT * FROM public.payout_destination_verifications x
         WHERE x.user_id = p.id AND x.destination_type = 'mobile_money'
           AND x.ownership_code_confirmed_at IS NOT NULL
           AND COALESCE(x.momo_number, '') <> ''
         ORDER BY x.ownership_code_confirmed_at ASC LIMIT 1) d ON true
     WHERE (COALESCE(btrim(COALESCE(p.national_id_photo_path, '')), '') = ''
            OR COALESCE(btrim(COALESCE(p.selfie_photo_path, '')), '') = '')
       AND NULLIF(btrim(COALESCE(p.linked_national_id, '')), '') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.user_identity_bindings b
                        WHERE b.user_id = p.id AND b.status <> 'revoked')
       AND EXISTS (SELECT 1 FROM public.user_identity_bindings ob
                    WHERE ob.user_id = o.id AND ob.status <> 'revoked')
       AND COALESCE(btrim(COALESCE(o.national_id_photo_path, '')), '') <> ''
       AND COALESCE(btrim(COALESCE(o.selfie_photo_path, '')), '') <> ''
  LOOP
    INSERT INTO public.user_identity_bindings (
      user_id, national_id, linked_national_id, full_legal_name,
      national_id_surname, national_id_given_name, date_of_birth, sex,
      national_id_card_number, national_id_photo_path, national_id_back_photo_path,
      selfie_photo_path, locked_payout_number, locked_payout_name, locked_payout_provider,
      status, capture_source
    ) VALUES (
      r.user_id, r.national_id, r.linked_national_id,
      COALESCE(NULLIF(btrim(COALESCE(r.national_id_name, '')), ''), r.full_name),
      r.national_id_surname, r.national_id_given_name, r.date_of_birth, r.sex,
      r.national_id_card_number, r.national_id_photo_path, r.national_id_back_photo_path,
      r.selfie_photo_path, r.momo_number, r.payout_name, NULLIF(r.payout_provider, ''),
      'identity_captured', 'linked_id_owner'
    )
    ON CONFLICT (user_id) DO NOTHING;

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (r.user_id, 'IDENTITY_CAPTURED', 'user_identity_bindings', r.user_id,
      jsonb_build_object(
        'reason', 'Linked identity bound by migration 20260924100000 - the account already met every condition.',
        'capture_source', 'linked_id_owner',
        'documents_from_id_owner', r.owner_id,
        'documents_from_id_owner_name', r.owner_name,
        'locked_number_last4', right(regexp_replace(r.momo_number, '\D', '', 'g'), 4)));

    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'linked identities bound by backfill: %', v_n;
END $backfill$;

-- Verify ------------------------------------------------------------------------
DO $verify$
DECLARE v_bound int; v_pending int; v_bad int;
BEGIN
  IF position('linked_id_owner' in (
       SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.proname='complete_identity_binding')) = 0 THEN
    RAISE EXCEPTION 'linked-identity path did not land - rolled back';
  END IF;

  -- The backfill must have produced bindings, or the rule reaches nobody and
  -- the four stuck accounts are still stuck.
  SELECT count(*) INTO v_bound
    FROM public.user_identity_bindings
   WHERE capture_source = 'linked_id_owner' AND status <> 'revoked';
  IF v_bound = 0 THEN
    RAISE EXCEPTION 'no linked binding was created - the rule reaches nobody, rolled back';
  END IF;

  -- THE GUARDRAIL, checked rather than trusted: no linked binding may exist for
  -- an account that never proved it controls its own payout number. That is the
  -- only thing tying the money to a person whose identity is borrowed.
  SELECT count(*) INTO v_bad
    FROM public.user_identity_bindings b
   WHERE b.capture_source = 'linked_id_owner' AND b.status <> 'revoked'
     AND NOT EXISTS (SELECT 1 FROM public.payout_destination_verifications d
                      WHERE d.user_id = b.user_id AND d.destination_type = 'mobile_money'
                        AND d.ownership_code_confirmed_at IS NOT NULL);
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% linked binding(s) exist without a proven payout number - rolled back', v_bad;
  END IF;

  -- Nor may one exist against an ID whose owner was never verified.
  SELECT count(*) INTO v_bad
    FROM public.user_identity_bindings b
   WHERE b.capture_source = 'linked_id_owner' AND b.status <> 'revoked'
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles o
         JOIN public.user_identity_bindings ob ON ob.user_id = o.id AND ob.status <> 'revoked'
        WHERE btrim(coalesce(o.national_id,'')) = btrim(coalesce(b.linked_national_id,'')));
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% linked binding(s) point at an unverified ID owner - rolled back', v_bad;
  END IF;

  -- Whoever is left needs one self-serve step that is genuinely theirs.
  SELECT count(*) INTO v_pending
    FROM public.profiles p
   WHERE (coalesce(btrim(coalesce(p.national_id_photo_path,'')),'') = ''
          OR coalesce(btrim(coalesce(p.selfie_photo_path,'')),'') = '')
     AND nullif(btrim(coalesce(p.linked_national_id,'')),'') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.user_identity_bindings b
                      WHERE b.user_id=p.id AND b.status<>'revoked');

  RAISE NOTICE 'linked identities: % bound and able to withdraw, % still to confirm a number they own',
    v_bound, v_pending;
END $verify$;
