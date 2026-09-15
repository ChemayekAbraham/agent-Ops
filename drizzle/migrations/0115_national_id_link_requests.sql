-- National ID group linking: a later account may be linked to a National ID that
-- another account already holds, but only when the holder proves ownership of
-- the phone number on record (code) AND answers Yes in the app, and staff then
-- confirm the details. Requests expire after 7 days. One ID carries at most 20
-- accounts (the holder plus 19 linked accounts).

CREATE TABLE IF NOT EXISTS public.national_id_link_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL,
  holder_id uuid NOT NULL,
  nin text NOT NULL,
  nin_fuzzy text NOT NULL,
  status text NOT NULL DEFAULT 'awaiting_owner',
  code_sent_at timestamptz,
  code_verified_at timestamptz,
  owner_confirmed_at timestamptz,
  owner_decision text,
  staff_decided_at timestamptz,
  staff_decided_by uuid,
  decision_reason text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT national_id_link_status_ck CHECK (status IN
    ('awaiting_owner','owner_approved','active','rejected_by_owner','rejected_by_staff','expired')),
  CONSTRAINT national_id_link_not_self_ck CHECK (requester_id IS DISTINCT FROM holder_id)
);

GRANT SELECT ON public.national_id_link_requests TO authenticated;
GRANT ALL ON public.national_id_link_requests TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS national_id_link_one_open
  ON public.national_id_link_requests (requester_id, nin_fuzzy)
  WHERE status IN ('awaiting_owner','owner_approved');
CREATE UNIQUE INDEX IF NOT EXISTS national_id_link_one_active
  ON public.national_id_link_requests (requester_id, nin_fuzzy)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS national_id_link_holder_idx
  ON public.national_id_link_requests (holder_id, status);
CREATE INDEX IF NOT EXISTS national_id_link_nin_idx
  ON public.national_id_link_requests (nin_fuzzy, status);

ALTER TABLE public.national_id_link_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own side reads link requests" ON public.national_id_link_requests;
CREATE POLICY "Own side reads link requests"
ON public.national_id_link_requests FOR SELECT TO authenticated
USING (requester_id = auth.uid() OR holder_id = auth.uid());

DROP POLICY IF EXISTS "Finance reads link requests" ON public.national_id_link_requests;
CREATE POLICY "Finance reads link requests"
ON public.national_id_link_requests FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'financial_ops'::app_role)
  OR public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
);

-- A linked account keeps its own profile; the National ID itself stays recorded
-- against the holder, so the linked account carries only the ID number.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS linked_national_id text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS linked_national_id_request_id uuid;

CREATE OR REPLACE FUNCTION public.national_id_link_expire_stale()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE public.national_id_link_requests
     SET status = 'expired', updated_at = now()
   WHERE status IN ('awaiting_owner','owner_approved')
     AND expires_at <= now();
$$;

CREATE OR REPLACE FUNCTION public.national_id_link_state(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  r public.national_id_link_requests;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;
  SELECT * INTO r FROM public.national_id_link_requests
   WHERE id = p_request_id AND (requester_id = v_uid OR holder_id = v_uid);
  IF r.id IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;
  RETURN jsonb_build_object(
    'found', true,
    'id', r.id,
    'nin', r.nin,
    'status', CASE WHEN r.status IN ('awaiting_owner','owner_approved') AND r.expires_at <= now()
                   THEN 'expired' ELSE r.status END,
    'code_sent', r.code_sent_at IS NOT NULL,
    'code_verified', r.code_verified_at IS NOT NULL,
    'owner_confirmed', r.owner_confirmed_at IS NOT NULL,
    'staff_confirmed', r.staff_decided_at IS NOT NULL,
    'expires_at', r.expires_at,
    'created_at', r.created_at,
    'decision_reason', r.decision_reason
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.national_id_link_state(uuid) TO authenticated;

-- Asks to join the group that already holds this National ID. Returns the open
-- request (creating it when there is none). Nothing about the holder is
-- returned: the requesting person only ever sees the ID number they typed.
CREATE OR REPLACE FUNCTION public.request_national_id_link(p_nin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_nin text := upper(regexp_replace(coalesce(p_nin,''), '[^A-Za-z0-9]', '', 'g'));
  v_fuzzy text;
  v_holder uuid;
  v_existing public.national_id_link_requests;
  v_count int;
  v_id uuid;
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

  SELECT * INTO v_existing FROM public.national_id_link_requests
   WHERE requester_id = v_uid AND nin_fuzzy = v_fuzzy
     AND status IN ('awaiting_owner','owner_approved','active')
   ORDER BY created_at DESC LIMIT 1;
  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'request_id', v_existing.id,
      'status', v_existing.status, 'nin', v_existing.nin, 'reused', true);
  END IF;

  -- The holder counts as one of the twenty.
  SELECT 1 + count(*) INTO v_count
    FROM public.national_id_link_requests
   WHERE nin_fuzzy = v_fuzzy AND status = 'active';
  IF v_count >= 20 THEN
    RETURN jsonb_build_object('success', false, 'full', true,
      'message', 'This National ID already carries the maximum of 20 accounts.');
  END IF;

  INSERT INTO public.national_id_link_requests (requester_id, holder_id, nin, nin_fuzzy)
  VALUES (v_uid, v_holder, v_nin, v_fuzzy)
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (v_uid, 'national_id_link_requested', 'national_id_link_requests', v_id::text,
          'Account asked to be linked to a National ID already recorded on another account.',
          jsonb_build_object('holder_id', v_holder, 'nin', v_nin));

  RETURN jsonb_build_object('success', true, 'request_id', v_id,
    'status', 'awaiting_owner', 'nin', v_nin);
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_national_id_link(text) TO authenticated;

-- Server-side only: hands the sending function the holder's phone number and the
-- requesting person's name. Never granted to signed-in users, because the
-- requesting person must not learn the holder's number.
CREATE OR REPLACE FUNCTION public.national_id_link_send_target(p_request_id uuid, p_requester_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r public.national_id_link_requests;
  v_phone text;
  v_name text;
BEGIN
  PERFORM public.national_id_link_expire_stale();
  SELECT * INTO r FROM public.national_id_link_requests
   WHERE id = p_request_id AND requester_id = p_requester_id;
  IF r.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'That request was not found.');
  END IF;
  IF r.status <> 'awaiting_owner' THEN
    RETURN jsonb_build_object('success', false, 'message', 'That request is no longer waiting for a code.');
  END IF;

  SELECT nullif(btrim(coalesce(phone,'')),'') INTO v_phone FROM public.profiles WHERE id = r.holder_id;
  IF v_phone IS NULL THEN
    RETURN jsonb_build_object('success', false,
      'message', 'The account holding that ID has no phone number on record. Contact Welile Support.');
  END IF;
  SELECT nullif(btrim(coalesce(full_name,'')),'') INTO v_name FROM public.profiles WHERE id = r.requester_id;

  UPDATE public.national_id_link_requests
     SET code_sent_at = now(), updated_at = now() WHERE id = r.id;

  RETURN jsonb_build_object('success', true, 'phone', v_phone,
    'requester_name', coalesce(v_name, 'A Welile user'), 'nin', r.nin);
END;
$$;

REVOKE ALL ON FUNCTION public.national_id_link_send_target(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.national_id_link_send_target(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.national_id_link_mark_code_verified(p_request_id uuid, p_requester_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r public.national_id_link_requests;
BEGIN
  PERFORM public.national_id_link_expire_stale();
  SELECT * INTO r FROM public.national_id_link_requests
   WHERE id = p_request_id AND requester_id = p_requester_id;
  IF r.id IS NULL OR r.status <> 'awaiting_owner' THEN
    RETURN jsonb_build_object('success', false, 'message', 'That request can no longer be confirmed.');
  END IF;

  UPDATE public.national_id_link_requests
     SET code_verified_at = coalesce(code_verified_at, now()), updated_at = now()
   WHERE id = r.id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (r.requester_id, 'national_id_link_code_verified', 'national_id_link_requests', r.id::text,
          'The code sent to the number on the National ID holder record was entered correctly.',
          jsonb_build_object('holder_id', r.holder_id));

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.national_id_link_mark_code_verified(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.national_id_link_mark_code_verified(uuid, uuid) TO service_role;

-- Only the holder answers. A Yes needs the code to have been entered first.
CREATE OR REPLACE FUNCTION public.national_id_link_owner_decision(
  p_request_id uuid, p_approve boolean, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  r public.national_id_link_requests;
  v_reason text := btrim(coalesce(p_reason,''));
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Please sign in again.');
  END IF;
  PERFORM public.national_id_link_expire_stale();

  SELECT * INTO r FROM public.national_id_link_requests
   WHERE id = p_request_id AND holder_id = v_uid;
  IF r.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'That request was not found.');
  END IF;
  IF r.status <> 'awaiting_owner' THEN
    RETURN jsonb_build_object('success', false, 'message', 'That request has already been answered.');
  END IF;

  IF p_approve THEN
    IF r.code_verified_at IS NULL THEN
      RETURN jsonb_build_object('success', false,
        'message', 'The person asking has not yet entered the code sent to your number.');
    END IF;
    UPDATE public.national_id_link_requests
       SET status = 'owner_approved', owner_decision = 'approved',
           owner_confirmed_at = now(), updated_at = now()
     WHERE id = r.id;
  ELSE
    UPDATE public.national_id_link_requests
       SET status = 'rejected_by_owner', owner_decision = 'rejected',
           owner_confirmed_at = now(),
           decision_reason = nullif(v_reason,''), updated_at = now()
     WHERE id = r.id;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (v_uid,
          CASE WHEN p_approve THEN 'national_id_link_owner_approved'
               ELSE 'national_id_link_owner_rejected' END,
          'national_id_link_requests', r.id::text,
          'The National ID holder answered the in-app request to link another account.',
          jsonb_build_object('approved', p_approve, 'requester_id', r.requester_id,
                             'note', nullif(v_reason,'')));

  RETURN jsonb_build_object('success', true,
    'status', CASE WHEN p_approve THEN 'owner_approved' ELSE 'rejected_by_owner' END);
END;
$$;

GRANT EXECUTE ON FUNCTION public.national_id_link_owner_decision(uuid, boolean, text) TO authenticated;

-- Staff only confirm the details the holder already approved.
CREATE OR REPLACE FUNCTION public.national_id_link_staff_confirm(
  p_request_id uuid, p_approve boolean, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  r public.national_id_link_requests;
  v_reason text := btrim(coalesce(p_reason,''));
BEGIN
  IF v_uid IS NULL
     OR NOT (public.has_role(v_uid,'financial_ops'::app_role)
             OR public.has_role(v_uid,'cfo'::app_role)
             OR public.has_role(v_uid,'super_admin'::app_role)) THEN
    RETURN jsonb_build_object('success', false, 'message', 'You are not allowed to confirm this.');
  END IF;
  IF length(v_reason) < 10 THEN
    RETURN jsonb_build_object('success', false,
      'message', 'Write at least 10 characters saying what you checked.');
  END IF;

  PERFORM public.national_id_link_expire_stale();

  SELECT * INTO r FROM public.national_id_link_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'That request was not found.');
  END IF;
  IF r.status <> 'owner_approved' THEN
    RETURN jsonb_build_object('success', false,
      'message', 'Only a request the ID holder has approved can be confirmed.');
  END IF;

  UPDATE public.national_id_link_requests
     SET status = CASE WHEN p_approve THEN 'active' ELSE 'rejected_by_staff' END,
         staff_decided_at = now(), staff_decided_by = v_uid,
         decision_reason = v_reason, updated_at = now()
   WHERE id = r.id;

  IF p_approve THEN
    UPDATE public.profiles
       SET linked_national_id = r.nin, linked_national_id_request_id = r.id
     WHERE id = r.requester_id;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (v_uid,
          CASE WHEN p_approve THEN 'national_id_link_confirmed'
               ELSE 'national_id_link_refused' END,
          'national_id_link_requests', r.id::text, v_reason,
          jsonb_build_object('approved', p_approve, 'requester_id', r.requester_id,
                             'holder_id', r.holder_id));

  RETURN jsonb_build_object('success', true,
    'status', CASE WHEN p_approve THEN 'active' ELSE 'rejected_by_staff' END);
END;
$$;

GRANT EXECUTE ON FUNCTION public.national_id_link_staff_confirm(uuid, boolean, text) TO authenticated;

-- A confirmed group member may now record the ID details on their own account.
-- The National ID number itself stays recorded against the holder; the linked
-- account carries the number only.
CREATE OR REPLACE FUNCTION public.submit_national_id_details(
  p_surname text, p_given_name text, p_nin text, p_date_of_birth date,
  p_card_number text, p_sex text, p_reading jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
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
      RETURN jsonb_build_object('success', false, 'duplicate', true, 'field', 'nin',
        'message', 'This National ID is already recorded on another account. Ask the person who holds it to confirm you.');
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
                             'edited_fields', to_jsonb(v_edited)));

  RETURN jsonb_build_object(
    'success', true,
    'reading_id', v_reading_id,
    'linked', v_linked,
    'edited_fields', to_jsonb(v_edited),
    'full_name', v_name,
    'message', 'National ID details saved.');
END;
$$;