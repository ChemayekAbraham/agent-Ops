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
    -- Server-side vetting: the number must be free or already this person's own.
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