CREATE TABLE IF NOT EXISTS public.payout_number_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  current_number text,
  requested_number text NOT NULL,
  requested_name text NOT NULL,
  requested_provider text,
  request_reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  ownership_code_confirmed_at timestamptz,
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_number_change_status_ck
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT payout_number_change_reason_ck CHECK (length(btrim(request_reason)) >= 10)
);

GRANT SELECT ON public.payout_number_change_requests TO authenticated;
GRANT ALL ON public.payout_number_change_requests TO service_role;

ALTER TABLE public.payout_number_change_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owner reads own number change requests" ON public.payout_number_change_requests;
CREATE POLICY "Owner reads own number change requests"
ON public.payout_number_change_requests FOR SELECT TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Finance reads number change requests" ON public.payout_number_change_requests;
CREATE POLICY "Finance reads number change requests"
ON public.payout_number_change_requests FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'manager')
);

CREATE UNIQUE INDEX IF NOT EXISTS payout_number_change_one_pending
  ON public.payout_number_change_requests (user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS payout_number_change_status_idx
  ON public.payout_number_change_requests (status, created_at DESC);

CREATE OR REPLACE FUNCTION public.confirm_payout_number_ownership(p_number text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_key text := right(regexp_replace(coalesce(p_number, ''), '\D', '', 'g'), 9);
  v_ok boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in first.';
  END IF;
  IF length(v_key) <> 9 THEN
    RAISE EXCEPTION 'That does not look like a mobile money number.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.otp_verifications o
    WHERE o.phone = v_key AND o.verified = true AND o.verified_at IS NOT NULL
      AND o.verified_at > now() - interval '24 hours'
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'Confirm the code sent to that number first.';
  END IF;

  UPDATE public.payout_destination_verifications d
  SET ownership_code_confirmed_at = coalesce(d.ownership_code_confirmed_at, now())
  WHERE d.user_id = v_uid
    AND d.destination_type = 'mobile_money'
    AND right(regexp_replace(coalesce(d.momo_number, ''), '\D', '', 'g'), 9) = v_key;

  RETURN jsonb_build_object('success', true, 'auto_verified', false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.finops_decide_payout_destination(p_id uuid, p_decision text, p_reason text, p_call_outcome text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_decision text := lower(btrim(coalesce(p_decision,'')));
  v_reason text := btrim(coalesce(p_reason,''));
  v_row public.payout_destination_verifications;
  v_id_name text;
  v_old_name text;
  v_source text;
  v_dup uuid;
  v_dup_name text;
  v_unreadable boolean := false;
  v_back text;
  v_dbl jsonb;
  v_double boolean := false;
  v_name_match numeric;
  v_staff boolean;
  v_back_cutoff constant timestamptz := timestamptz '2026-09-14 14:00:00+00';
BEGIN
  IF v_decision NOT IN ('verified','rejected') THEN
    RAISE EXCEPTION 'Decision must be verified or rejected.';
  END IF;
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Write at least 10 characters explaining the decision.';
  END IF;

  SELECT * INTO v_row FROM public.payout_destination_verifications WHERE id = p_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Destination not found.';
  END IF;

  v_staff := v_uid IS NOT NULL AND (
    public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'super_admin')
  );
  IF NOT v_staff THEN
    RAISE EXCEPTION 'Only Financial Ops can verify payout destinations.';
  END IF;

  v_name_match := coalesce((public.payout_name_match_report(
      coalesce(nullif(btrim(coalesce(v_row.final_name_override,'')), ''), v_row.national_id_name),
      v_row.account_name)->>'score')::numeric, 0);

  IF v_decision = 'verified'
     AND v_name_match < 0.9
     AND coalesce(v_row.national_id_submitted_at, v_row.first_seen_at) >= v_back_cutoff THEN
    SELECT nullif(btrim(coalesce(national_id_back_photo_path,'')), '') INTO v_back
    FROM public.profiles WHERE id = v_row.user_id;
    IF v_back IS NULL THEN
      RAISE EXCEPTION 'Cannot verify — the back of the National ID is missing. Ask the user to upload a photo of the back of their National ID.';
    END IF;
  END IF;

  v_dbl := public.identity_double_submission(v_row.user_id);
  IF v_decision = 'verified' AND coalesce((v_dbl ->> 'is_double')::boolean, false) THEN
    v_double := true;
    v_decision := 'rejected';
    v_reason := 'Automatically rejected as a double submission: this '
                || CASE WHEN v_dbl ->> 'kind' = 'phone' THEN 'phone number' ELSE 'National ID' END
                || ' already verifies another account ('
                || coalesce(nullif(btrim(coalesce(v_dbl ->> 'first_name','')), ''), 'unnamed account')
                || '). Only the first account may use it.';
  END IF;

  v_dup := public.duplicate_national_id_owner(v_row.user_id, v_row.national_id);
  IF v_dup IS NOT NULL AND v_decision = 'verified' THEN
    SELECT full_name INTO v_dup_name FROM public.profiles WHERE id = v_dup;
    v_decision := 'rejected';
    v_reason := 'Automatically rejected: this National ID is already recorded on another account ('
                || coalesce(v_dup_name, 'unnamed account') || '). One National ID may only be used by one account.';
  END IF;

  IF v_decision = 'verified' THEN
    v_id_name := btrim(coalesce(nullif(btrim(coalesce(v_row.final_name_override,'')), ''), v_row.national_id_name, ''));
    IF length(v_id_name) < 3 THEN
      v_unreadable := true;
      v_decision := 'rejected';
      v_reason := 'Automatically rejected: no name could be read on the National ID photo. Ask the user to submit a clearer photo of their National ID.';
    END IF;
  END IF;

  UPDATE public.payout_destination_verifications
  SET status = v_decision,
      decision_reason = v_reason,
      call_outcome = nullif(btrim(coalesce(p_call_outcome,'')), ''),
      decided_by = v_uid,
      decided_at = now()
  WHERE id = p_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
  VALUES (v_uid, 'payout_destination_' || v_decision, 'payout_destination_verifications', p_id::text, v_reason,
          jsonb_build_object('status', v_row.status),
          jsonb_build_object('status', v_decision, 'call_outcome', p_call_outcome, 'owner', v_row.user_id,
                             'duplicate_of_user_id', v_dup,
                             'auto_rejected_double_submission', v_double,
                             'auto_rejected_unreadable_id_name', v_unreadable,
                             'double_submission', v_dbl,
                             'name_match_score', v_name_match,
                             'single_side_id_accepted', (v_name_match >= 0.9)));

  IF v_decision = 'verified' THEN
    SELECT full_name INTO v_old_name FROM public.profiles WHERE id = v_row.user_id;
    IF v_id_name IS NOT NULL AND length(v_id_name) >= 3 AND coalesce(v_old_name,'') IS DISTINCT FROM v_id_name THEN
      UPDATE public.profiles SET full_name = v_id_name, updated_at = now() WHERE id = v_row.user_id;
      v_source := CASE WHEN nullif(btrim(coalesce(v_row.final_name_override,'')), '') IS NOT NULL
                       THEN 'final_name_override' ELSE 'national_id_name' END;
      INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
      VALUES (v_uid, 'payout_holder_name_from_national_id', 'profiles', v_row.user_id::text,
              'Account name replaced with the exact name read on the verified National ID.',
              jsonb_build_object('full_name', v_old_name),
              jsonb_build_object('full_name', v_id_name, 'source', v_source));
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'status', v_decision, 'reason', v_reason);
END;
$function$;

CREATE OR REPLACE FUNCTION public.payout_withdrawal_block_reasons(p_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := coalesce(p_user_id, auth.uid());
  v_caller uuid := auth.uid();
  v_p record;
  v_binding record;
  v_dest record;
  v_face boolean;
  v_reasons text[] := ARRAY[]::text[];
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('blocked', true, 'code', 'unauthorized', 'reasons', to_jsonb(ARRAY['Sign in first.']));
  END IF;
  IF v_uid <> v_caller AND NOT (
       public.has_role(v_caller, 'financial_ops') OR public.has_role(v_caller, 'cfo')
       OR public.has_role(v_caller, 'super_admin') OR public.has_role(v_caller, 'manager')) THEN
    RAISE EXCEPTION 'Not allowed.';
  END IF;

  SELECT national_id, linked_national_id, national_id_photo_path, national_id_back_photo_path,
         selfie_photo_path, mobile_money_number, mobile_money_name
    INTO v_p
  FROM public.profiles WHERE id = v_uid;

  SELECT * INTO v_binding
  FROM public.user_identity_bindings
  WHERE user_id = v_uid AND status <> 'revoked' AND coalesce(locked_payout_number, '') <> '';

  SELECT * INTO v_dest
  FROM public.payout_destination_verifications
  WHERE user_id = v_uid AND destination_type = 'mobile_money'
  ORDER BY (status = 'rejected') DESC, updated_at DESC NULLS LAST
  LIMIT 1;

  SELECT face_verified INTO v_face
  FROM public.national_id_readings WHERE user_id = v_uid ORDER BY created_at DESC LIMIT 1;

  IF v_dest.id IS NOT NULL AND v_dest.status = 'rejected' THEN
    IF coalesce(btrim(coalesce(v_dest.decision_reason, '')), '') <> '' THEN
      v_reasons := v_reasons || v_dest.decision_reason;
    END IF;
    IF coalesce(btrim(coalesce(v_p.national_id_photo_path, '')), '') = '' THEN
      v_reasons := v_reasons || 'Take a clear photo of the front of your National ID.';
    END IF;
    IF coalesce(btrim(coalesce(v_p.national_id_back_photo_path, '')), '') = '' THEN
      v_reasons := v_reasons || 'Take a photo of the back of your National ID.';
    END IF;
    IF coalesce(btrim(coalesce(v_p.selfie_photo_path, '')), '') = '' OR coalesce(v_face, false) IS NOT TRUE THEN
      v_reasons := v_reasons || 'Take a new selfie in good light, with your whole face visible.';
    END IF;
    v_reasons := v_reasons || 'Check that the name on your mobile money number is the same name printed on your National ID.';
    v_reasons := v_reasons || 'When it is all corrected, submit again and Financial Ops will look at it.';
    RETURN jsonb_build_object('blocked', true, 'code', 'destination_rejected',
      'headline', 'Oops! It seems your details did not meet the criteria.',
      'reasons', to_jsonb(v_reasons));
  END IF;

  IF v_binding.id IS NULL THEN
    IF coalesce(nullif(btrim(coalesce(v_p.national_id, '')), ''), nullif(btrim(coalesce(v_p.linked_national_id, '')), '')) IS NULL THEN
      v_reasons := v_reasons || 'Enter your National ID number and the exact names printed on the card.';
    END IF;
    IF coalesce(btrim(coalesce(v_p.national_id_photo_path, '')), '') = '' THEN
      v_reasons := v_reasons || 'Take a photo of the front of your National ID.';
    END IF;
    IF coalesce(btrim(coalesce(v_p.selfie_photo_path, '')), '') = '' THEN
      v_reasons := v_reasons || 'Take a selfie with your whole face visible.';
    END IF;
    IF coalesce(btrim(coalesce(v_p.mobile_money_number, '')), '') = ''
       OR coalesce(btrim(coalesce(v_p.mobile_money_name, '')), '') = '' THEN
      v_reasons := v_reasons || 'Add the mobile money number that will receive your money and confirm it with the code we send.';
    END IF;
    IF array_length(v_reasons, 1) IS NULL THEN
      v_reasons := v_reasons || 'Finish the identity step on your wallet so your withdrawal number can be linked to you.';
    END IF;
    RETURN jsonb_build_object('blocked', true, 'code', 'identity_not_submitted',
      'headline', 'Oops! Your withdrawal details are not complete yet.',
      'reasons', to_jsonb(v_reasons));
  END IF;

  RETURN jsonb_build_object('blocked', false, 'code', 'ok',
    'status', coalesce(v_dest.status, 'waiting'),
    'reasons', to_jsonb(ARRAY[]::text[]));
END;
$function$;

GRANT EXECUTE ON FUNCTION public.payout_withdrawal_block_reasons(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.request_payout_number_change(
  p_number text,
  p_name text,
  p_provider text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_key text := right(regexp_replace(coalesce(p_number, ''), '\D', '', 'g'), 9);
  v_name text := btrim(coalesce(p_name, ''));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_prov text := lower(btrim(coalesce(p_provider, '')));
  v_binding record;
  v_owner uuid;
  v_ok boolean;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF length(v_key) <> 9 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_number',
      'message', 'Enter a valid mobile money number.');
  END IF;
  IF array_length(regexp_split_to_array(v_name, '\s+'), 1) < 2 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_name',
      'message', 'Enter the full name exactly as it shows on that mobile money number.');
  END IF;
  IF length(v_reason) < 10 THEN
    RETURN jsonb_build_object('success', false, 'code', 'reason_too_short',
      'message', 'Explain in at least 10 characters why the number must change.');
  END IF;
  IF v_prov NOT IN ('mtn', 'airtel') THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_provider',
      'message', 'Choose MTN or Airtel.');
  END IF;

  SELECT * INTO v_binding
  FROM public.user_identity_bindings
  WHERE user_id = v_uid AND status <> 'revoked';
  IF v_binding.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'no_identity',
      'message', 'Record your identity details first — there is no locked number to change yet.');
  END IF;

  IF right(regexp_replace(coalesce(v_binding.locked_payout_number, ''), '\D', '', 'g'), 9) = v_key THEN
    RETURN jsonb_build_object('success', false, 'code', 'same_number',
      'message', 'That is already your withdrawal number.');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.otp_verifications o
    WHERE o.phone = v_key AND o.verified = true AND o.verified_at IS NOT NULL
      AND o.verified_at > now() - interval '24 hours'
  ) INTO v_ok;
  IF NOT v_ok THEN
    RETURN jsonb_build_object('success', false, 'code', 'ownership_unconfirmed',
      'message', 'Confirm the code we send to the new number first.');
  END IF;

  SELECT id INTO v_owner FROM public.profiles
  WHERE id <> v_uid AND right(regexp_replace(coalesce(mobile_money_number, ''), '\D', '', 'g'), 9) = v_key
  LIMIT 1;
  IF v_owner IS NULL THEN
    SELECT user_id INTO v_owner FROM public.user_identity_bindings
    WHERE user_id <> v_uid AND status <> 'revoked'
      AND right(regexp_replace(coalesce(locked_payout_number, ''), '\D', '', 'g'), 9) = v_key
    LIMIT 1;
  END IF;
  IF v_owner IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'number_taken',
      'message', 'That number is already used for withdrawals on another account.');
  END IF;

  IF EXISTS (SELECT 1 FROM public.payout_number_change_requests
             WHERE user_id = v_uid AND status = 'pending') THEN
    RETURN jsonb_build_object('success', false, 'code', 'already_pending',
      'message', 'You already have a number change waiting for Financial Ops.');
  END IF;

  INSERT INTO public.payout_number_change_requests (
    user_id, current_number, requested_number, requested_name, requested_provider,
    request_reason, ownership_code_confirmed_at
  ) VALUES (
    v_uid, v_binding.locked_payout_number, btrim(p_number), v_name, v_prov, v_reason, now()
  )
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (v_uid, 'PAYOUT_NUMBER_CHANGE_REQUESTED', 'payout_number_change_requests', v_id::text, v_reason,
          jsonb_build_object('from_last4', right(regexp_replace(coalesce(v_binding.locked_payout_number,''), '\D', '', 'g'), 4),
                             'to_last4', right(v_key, 4), 'provider', v_prov));

  RETURN jsonb_build_object('success', true, 'code', 'submitted', 'request_id', v_id);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.request_payout_number_change(text, text, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cancel_payout_number_change(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  UPDATE public.payout_number_change_requests
  SET status = 'cancelled', updated_at = now()
  WHERE id = p_request_id AND user_id = v_uid AND status = 'pending';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_pending');
  END IF;
  RETURN jsonb_build_object('success', true);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.cancel_payout_number_change(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.finops_decide_payout_number_change(
  p_request_id uuid,
  p_decision text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_decision text := lower(btrim(coalesce(p_decision, '')));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_row public.payout_number_change_requests;
  v_dest record;
BEGIN
  IF NOT (public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo')
          OR public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'manager')) THEN
    RAISE EXCEPTION 'Only Financial Ops can decide a withdrawal number change.';
  END IF;
  IF v_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Decision must be approved or rejected.';
  END IF;
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Write at least 10 characters explaining the decision.';
  END IF;

  SELECT * INTO v_row FROM public.payout_number_change_requests WHERE id = p_request_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Request not found.';
  END IF;
  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'This request was already decided.';
  END IF;
  IF v_row.user_id = v_uid THEN
    RAISE EXCEPTION 'You cannot decide your own withdrawal number change.';
  END IF;

  IF v_decision = 'approved' THEN
    PERFORM set_config('payout.number_change_authorized', 'true', true);

    UPDATE public.user_identity_bindings
    SET locked_payout_number = btrim(v_row.requested_number),
        locked_payout_name = v_row.requested_name,
        locked_payout_provider = v_row.requested_provider,
        updated_at = now()
    WHERE user_id = v_row.user_id AND status <> 'revoked';

    UPDATE public.profiles
    SET mobile_money_number = btrim(v_row.requested_number),
        mobile_money_name = v_row.requested_name,
        mobile_money_provider = v_row.requested_provider,
        updated_at = now()
    WHERE id = v_row.user_id;

    PERFORM set_config('payout.number_change_authorized', 'false', true);

    SELECT * INTO v_dest FROM public.ensure_payout_destination(
      v_row.user_id, 'mobile_money', btrim(v_row.requested_number), v_row.requested_name,
      v_row.requested_provider, NULL, NULL, NULL);

    UPDATE public.payout_destination_verifications
    SET status = 'verified',
        decision_reason = 'Withdrawal number change approved by Financial Ops: ' || v_reason,
        ownership_code_confirmed_at = coalesce(ownership_code_confirmed_at, v_row.ownership_code_confirmed_at, now()),
        decided_by = v_uid,
        decided_at = now()
    WHERE id = v_dest.id;
  END IF;

  UPDATE public.payout_number_change_requests
  SET status = v_decision,
      decision_reason = v_reason,
      decided_by = v_uid,
      decided_at = now(),
      updated_at = now()
  WHERE id = p_request_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
  VALUES (v_uid,
          CASE WHEN v_decision = 'approved' THEN 'PAYOUT_NUMBER_CHANGE_APPROVED'
               ELSE 'PAYOUT_NUMBER_CHANGE_REJECTED' END,
          'payout_number_change_requests', p_request_id::text, v_reason,
          jsonb_build_object('locked_last4', right(regexp_replace(coalesce(v_row.current_number,''), '\D', '', 'g'), 4)),
          jsonb_build_object('owner', v_row.user_id,
                             'new_last4', right(regexp_replace(coalesce(v_row.requested_number,''), '\D', '', 'g'), 4),
                             'provider', v_row.requested_provider));

  RETURN jsonb_build_object('success', true, 'status', v_decision);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.finops_decide_payout_number_change(uuid, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.identity_binding_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_field text;
  v_change_ok boolean := coalesce(current_setting('payout.number_change_authorized', true), 'false') = 'true';
BEGIN
  IF OLD.status = 'revoked' THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  FOREACH v_field IN ARRAY ARRAY[
    'national_id', 'national_id_card_number', 'national_id_photo_path',
    'national_id_back_photo_path', 'selfie_photo_path',
    'locked_payout_number'
  ] LOOP
    CONTINUE WHEN v_field = 'locked_payout_number' AND v_change_ok;
    IF (to_jsonb(OLD) ->> v_field) IS NOT NULL
       AND coalesce(to_jsonb(NEW) ->> v_field, '') <> coalesce(to_jsonb(OLD) ->> v_field, '') THEN
      BEGIN
        INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
        VALUES (auth.uid(), 'IDENTITY_REPLACEMENT_ATTEMPT', 'user_identity_bindings', OLD.id,
                jsonb_build_object('field', v_field, 'reason', 'Identity binding is immutable once captured.'));
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
      RAISE EXCEPTION 'Your identity details are already linked to this account and cannot be changed here. Ask Financial Ops to approve a withdrawal number change.';
    END IF;
  END LOOP;

  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.finops_payout_number_change_requests(p_status text DEFAULT 'pending')
RETURNS TABLE(
  id uuid,
  user_id uuid,
  full_name text,
  phone text,
  national_id text,
  current_number text,
  requested_number text,
  requested_name text,
  requested_provider text,
  request_reason text,
  status text,
  ownership_code_confirmed_at timestamptz,
  decision_reason text,
  decided_by_name text,
  decided_at timestamptz,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'financial_ops') OR public.has_role(auth.uid(), 'cfo')
          OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'manager')) THEN
    RAISE EXCEPTION 'Not allowed.';
  END IF;

  RETURN QUERY
  SELECT r.id, r.user_id, p.full_name, p.phone,
         coalesce(p.national_id, p.linked_national_id),
         r.current_number, r.requested_number, r.requested_name, r.requested_provider,
         r.request_reason, r.status, r.ownership_code_confirmed_at,
         r.decision_reason, d.full_name, r.decided_at, r.created_at
  FROM public.payout_number_change_requests r
  LEFT JOIN public.profiles p ON p.id = r.user_id
  LEFT JOIN public.profiles d ON d.id = r.decided_by
  WHERE (p_status IS NULL OR p_status = 'all' OR r.status = p_status)
  ORDER BY r.created_at DESC
  LIMIT 200;
END;
$function$;