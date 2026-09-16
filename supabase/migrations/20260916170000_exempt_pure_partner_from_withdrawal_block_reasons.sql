-- payout_withdrawal_block_reasons() drives WithdrawFlow.tsx's identityBlock
-- state, which disables the Withdraw button and forces the ID+selfie capture
-- panel open whenever it reports blocked=true. Unlike every other gate in this
-- flow (enforce_withdrawal_destination_verified, submit_withdrawal_request's
-- ensure_payout_destination call, withdrawal_user_id_verified), this function
-- never checked the pure-partner exemption (user_is_pure_partner) at all — it
-- unconditionally demanded ID photo + selfie whenever the caller had no
-- user_identity_bindings row, which a pure funder/partner never needs. Found
-- 2026-09-16: Nankambo Sharimah (funder, 5 portfolios, zero agent activity)
-- was shown "submit your ID and selfie" even though the real DB-level gate
-- already exempts her. Mirrors enforce_withdrawal_destination_verified's own
-- precedence: the exemption short-circuits before the rejected-destination
-- check too, same as that trigger already does.
create or replace function public.payout_withdrawal_block_reasons(p_user_id uuid DEFAULT NULL::uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
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
    RETURN jsonb_build_object('blocked', true, 'code', 'unauthorized',
      'reasons', to_jsonb(ARRAY['Sign in first.'::text]));
  END IF;
  IF v_uid <> v_caller AND NOT (
       public.has_role(v_caller, 'financial_ops') OR public.has_role(v_caller, 'cfo')
       OR public.has_role(v_caller, 'super_admin') OR public.has_role(v_caller, 'manager')) THEN
    RAISE EXCEPTION 'Not allowed.';
  END IF;

  IF public.user_is_pure_partner(v_uid) THEN
    RETURN jsonb_build_object('blocked', false, 'code', 'ok',
      'status', 'verified', 'reasons', to_jsonb(ARRAY[]::text[]));
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
      v_reasons := array_append(v_reasons, v_dest.decision_reason::text);
    END IF;
    IF coalesce(btrim(coalesce(v_p.national_id_photo_path, '')), '') = '' THEN
      v_reasons := array_append(v_reasons, 'Take a clear photo of the front of your National ID.'::text);
    END IF;
    IF coalesce(btrim(coalesce(v_p.national_id_back_photo_path, '')), '') = '' THEN
      v_reasons := array_append(v_reasons, 'Take a photo of the back of your National ID.'::text);
    END IF;
    IF coalesce(btrim(coalesce(v_p.selfie_photo_path, '')), '') = '' OR coalesce(v_face, false) IS NOT TRUE THEN
      v_reasons := array_append(v_reasons, 'Take a new selfie in good light, with your whole face visible.'::text);
    END IF;
    v_reasons := array_append(v_reasons, 'Check that the name on your mobile money number is the same name printed on your National ID.'::text);
    v_reasons := array_append(v_reasons, 'When it is all corrected, submit again and Financial Ops will look at it.'::text);
    RETURN jsonb_build_object('blocked', true, 'code', 'destination_rejected',
      'headline', 'Oops! It seems your details did not meet the criteria.',
      'reasons', to_jsonb(v_reasons));
  END IF;

  IF v_binding.id IS NULL THEN
    IF coalesce(nullif(btrim(coalesce(v_p.national_id, '')), ''), nullif(btrim(coalesce(v_p.linked_national_id, '')), '')) IS NULL THEN
      v_reasons := array_append(v_reasons, 'Enter your National ID number and the exact names printed on the card.'::text);
    END IF;
    IF coalesce(btrim(coalesce(v_p.national_id_photo_path, '')), '') = '' THEN
      v_reasons := array_append(v_reasons, 'Take a photo of the front of your National ID.'::text);
    END IF;
    IF coalesce(btrim(coalesce(v_p.selfie_photo_path, '')), '') = '' THEN
      v_reasons := array_append(v_reasons, 'Take a selfie with your whole face visible.'::text);
    END IF;
    IF coalesce(btrim(coalesce(v_p.mobile_money_number, '')), '') = ''
       OR coalesce(btrim(coalesce(v_p.mobile_money_name, '')), '') = '' THEN
      v_reasons := array_append(v_reasons, 'Add the mobile money number that will receive your money and confirm it with the code we send.'::text);
    END IF;
    IF array_length(v_reasons, 1) IS NULL THEN
      v_reasons := array_append(v_reasons, 'Finish the identity step on your wallet so your withdrawal number can be linked to you.'::text);
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
