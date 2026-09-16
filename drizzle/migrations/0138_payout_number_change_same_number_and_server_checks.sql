-- 1. Live server-side availability check for the number the person is typing.
CREATE OR REPLACE FUNCTION public.check_payout_number_availability(p_number text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_key text := right(regexp_replace(coalesce(p_number, ''), '\D', '', 'g'), 9);
  v_locked text;
  v_owner uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('state', 'unknown', 'message', 'Sign in first.');
  END IF;
  IF length(v_key) <> 9 THEN
    RETURN jsonb_build_object('state', 'invalid', 'message', 'Enter a valid mobile money number.');
  END IF;

  SELECT right(regexp_replace(coalesce(locked_payout_number, ''), '\D', '', 'g'), 9)
    INTO v_locked
  FROM public.user_identity_bindings
  WHERE user_id = v_uid AND status <> 'revoked'
  LIMIT 1;

  IF v_locked = v_key THEN
    RETURN jsonb_build_object('state', 'mine', 'message',
      'This is already your withdrawal number. Ask Financial Ops to update the registered name on it.');
  END IF;

  SELECT id INTO v_owner FROM public.profiles
  WHERE id <> v_uid
    AND right(regexp_replace(coalesce(mobile_money_number, ''), '\D', '', 'g'), 9) = v_key
  LIMIT 1;
  IF v_owner IS NULL THEN
    SELECT user_id INTO v_owner FROM public.user_identity_bindings
    WHERE user_id <> v_uid AND status <> 'revoked'
      AND right(regexp_replace(coalesce(locked_payout_number, ''), '\D', '', 'g'), 9) = v_key
    LIMIT 1;
  END IF;
  IF v_owner IS NOT NULL THEN
    RETURN jsonb_build_object('state', 'taken', 'message',
      'That number is already used for withdrawals on another account.');
  END IF;

  RETURN jsonb_build_object('state', 'free', 'message', 'This number is not used on any other account.');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.check_payout_number_availability(text) TO authenticated, service_role;

-- 2. Allow a same-number request (registered name / provider correction) and keep the
--    "belongs to somebody else" refusal server side.
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
  v_same_number boolean;
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
      'message', 'Explain in at least 10 characters what must change.');
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

  v_same_number := right(regexp_replace(coalesce(v_binding.locked_payout_number, ''), '\D', '', 'g'), 9) = v_key;

  -- Same number is a legitimate request: the registered name or the provider is
  -- being corrected. Only refuse when literally nothing would change.
  IF v_same_number
     AND upper(btrim(coalesce(v_binding.locked_payout_name, ''))) = upper(v_name)
     AND lower(btrim(coalesce(v_binding.locked_payout_provider, ''))) = v_prov THEN
    RETURN jsonb_build_object('success', false, 'code', 'nothing_to_change',
      'message', 'These are already your saved withdrawal details. Change the number, the registered name or the provider first.');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.otp_verifications o
    WHERE o.phone = v_key AND o.verified = true AND o.verified_at IS NOT NULL
      AND o.verified_at > now() - interval '24 hours'
  ) INTO v_ok;
  IF NOT v_ok THEN
    RETURN jsonb_build_object('success', false, 'code', 'ownership_unconfirmed',
      'message', 'Confirm the code we send to that number first.');
  END IF;

  IF NOT v_same_number THEN
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
  END IF;

  IF EXISTS (SELECT 1 FROM public.payout_number_change_requests
             WHERE user_id = v_uid AND status = 'pending') THEN
    RETURN jsonb_build_object('success', false, 'code', 'already_pending',
      'message', 'You already have a change waiting for Financial Ops.');
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
                             'to_last4', right(v_key, 4), 'provider', v_prov,
                             'same_number', v_same_number,
                             'kind', CASE WHEN v_same_number THEN 'name_or_provider_update' ELSE 'number_change' END));

  RETURN jsonb_build_object('success', true, 'code', 'submitted', 'request_id', v_id,
    'kind', CASE WHEN v_same_number THEN 'name_or_provider_update' ELSE 'number_change' END);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.request_payout_number_change(text, text, text, text) TO authenticated, service_role;

-- 3. Financial Ops vetting: re-check ownership at decision time. An approval can
--    never point a payout number that belongs to another account at this user.
CREATE OR REPLACE FUNCTION public.finops_payout_number_check(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.payout_number_change_requests;
  v_key text;
  v_locked text;
  v_owner uuid;
  v_owner_name text;
BEGIN
  IF NOT (public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo')
          OR public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'manager')) THEN
    RAISE EXCEPTION 'Only Financial Ops can vet a withdrawal number change.';
  END IF;

  SELECT * INTO v_row FROM public.payout_number_change_requests WHERE id = p_request_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Request not found.';
  END IF;

  v_key := right(regexp_replace(coalesce(v_row.requested_number, ''), '\D', '', 'g'), 9);

  SELECT right(regexp_replace(coalesce(locked_payout_number, ''), '\D', '', 'g'), 9)
    INTO v_locked
  FROM public.user_identity_bindings
  WHERE user_id = v_row.user_id AND status <> 'revoked'
  LIMIT 1;

  SELECT p.id, p.full_name INTO v_owner, v_owner_name FROM public.profiles p
  WHERE p.id <> v_row.user_id
    AND right(regexp_replace(coalesce(p.mobile_money_number, ''), '\D', '', 'g'), 9) = v_key
  LIMIT 1;
  IF v_owner IS NULL THEN
    SELECT b.user_id, p.full_name INTO v_owner, v_owner_name
    FROM public.user_identity_bindings b
    LEFT JOIN public.profiles p ON p.id = b.user_id
    WHERE b.user_id <> v_row.user_id AND b.status <> 'revoked'
      AND right(regexp_replace(coalesce(b.locked_payout_number, ''), '\D', '', 'g'), 9) = v_key
    LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'request_id', v_row.id,
    'state', CASE WHEN v_owner IS NOT NULL THEN 'taken'
                  WHEN v_locked = v_key THEN 'same_as_current'
                  ELSE 'free' END,
    'is_same_number', (v_locked = v_key),
    'kind', CASE WHEN v_locked = v_key THEN 'name_or_provider_update' ELSE 'number_change' END,
    'other_holder_name', v_owner_name,
    'code_confirmed_at', v_row.ownership_code_confirmed_at,
    'approvable', (v_owner IS NULL),
    'message', CASE
      WHEN v_owner IS NOT NULL THEN 'This number is already used for withdrawals on another account — reject with that reason.'
      WHEN v_locked = v_key THEN 'Same number as now. This is a registered-name or provider correction.'
      ELSE 'This number is not used on any other account.' END);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.finops_payout_number_check(uuid) TO authenticated, service_role;

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
  v_key text;
  v_owner uuid;
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
    v_key := right(regexp_replace(coalesce(v_row.requested_number, ''), '\D', '', 'g'), 9);
    IF length(v_key) <> 9 THEN
      RAISE EXCEPTION 'The requested number is not a valid mobile money number.';
    END IF;
    IF v_row.ownership_code_confirmed_at IS NULL THEN
      RAISE EXCEPTION 'The holder never confirmed the code sent to that number.';
    END IF;

    SELECT id INTO v_owner FROM public.profiles
    WHERE id <> v_row.user_id
      AND right(regexp_replace(coalesce(mobile_money_number, ''), '\D', '', 'g'), 9) = v_key
    LIMIT 1;
    IF v_owner IS NULL THEN
      SELECT user_id INTO v_owner FROM public.user_identity_bindings
      WHERE user_id <> v_row.user_id AND status <> 'revoked'
        AND right(regexp_replace(coalesce(locked_payout_number, ''), '\D', '', 'g'), 9) = v_key
      LIMIT 1;
    END IF;
    IF v_owner IS NOT NULL THEN
      RAISE EXCEPTION 'That number is already used for withdrawals on another account. Reject this request with that reason.';
    END IF;

    PERFORM set_config('payout.number_change_authorized', 'true', true);

    UPDATE public.user_identity_bindings
    SET locked_payout_number = btrim(v_row.requested_number),
        locked_payout_name = v_row.requested_name,
        locked_payout_provider = v_row.requested_provider,
        updated_at = now()
    WHERE user_id = v_row.user_id AND status <> 'revoked';

    UPDATE public.payout_destinations
    SET destination_number = btrim(v_row.requested_number),
        holder_name = v_row.requested_name,
        provider = v_row.requested_provider,
        status = 'waiting',
        updated_at = now()
    WHERE user_id = v_row.user_id
    RETURNING * INTO v_dest;
  END IF;

  UPDATE public.payout_number_change_requests
  SET status = v_decision,
      decision_reason = v_reason,
      decided_by = v_uid,
      decided_at = now(),
      updated_at = now()
  WHERE id = p_request_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (v_uid, 'PAYOUT_NUMBER_CHANGE_' || upper(v_decision), 'payout_number_change_requests',
          p_request_id::text, v_reason,
          jsonb_build_object('subject_user', v_row.user_id,
                             'to_last4', right(regexp_replace(coalesce(v_row.requested_number,''), '\D', '', 'g'), 4)));

  RETURN jsonb_build_object('success', true, 'status', v_decision);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.finops_decide_payout_number_change(uuid, text, text) TO authenticated, service_role;