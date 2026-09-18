-- payout_withdrawal_block_reasons() never checked id_verification_exceptions,
-- so a CTO-granted exception (public.cto_grant_id_verification_exception,
-- 20260914240000) silences withdrawal_user_id_verified() -- the merchant-
-- claim gate -- but the Withdraw screen's own gate (WithdrawFlow.tsx's
-- identityBlock, fed by this RPC) never learned about it and kept demanding
-- National ID + selfie. Same shape as 20260916170000's missing
-- user_is_pure_partner exemption, different exemption source: this function
-- has now missed two independent "this person doesn't need ID verification"
-- signals in a row, so check both known signals here going forward.
--
-- Found investigating bwayo mark (fe1e9f51-a2c3-49fc-bd40-b2c143afe628):
-- active id_verification_exceptions row (granted 2026-09-18, reason
-- "VCERIFIED HR 101"), withdrawal_user_id_verified() correctly returns true,
-- but payout_withdrawal_block_reasons() still returned
-- {"blocked": true, "code": "identity_not_submitted"} because she has no
-- national_id/photos on file and the function had no exception check at all.
--
-- Fix: short-circuit to blocked=false when an active (unrevoked) exception
-- exists, same precedence as the pure-partner check (before the
-- rejected-destination and identity-binding checks) -- an exception means
-- skip ID verification entirely, not skip one leg of it.

CREATE OR REPLACE FUNCTION public.payout_withdrawal_block_reasons(p_user_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := coalesce(p_user_id, auth.uid());
  v_caller uuid := auth.uid();
  v_p record;
  v_binding record;
  v_dest public.payout_destination_verifications%ROWTYPE;
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

  IF EXISTS (
    SELECT 1 FROM public.id_verification_exceptions e
    WHERE e.user_id = v_uid AND e.revoked_at IS NULL
  ) THEN
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

  -- The locked payout number (set once, Financial-Ops-gated to change) is
  -- the authoritative "current destination" signal — prefer it over
  -- recency, which the mass-touch trigger above can tie across every
  -- destination the user has ever had.
  IF v_binding.id IS NOT NULL THEN
    SELECT * INTO v_dest
    FROM public.payout_destination_verifications
    WHERE user_id = v_uid AND destination_type = 'mobile_money'
      AND right(regexp_replace(coalesce(momo_number, ''), '\D', '', 'g'), 9)
          = right(regexp_replace(coalesce(v_binding.locked_payout_number, ''), '\D', '', 'g'), 9)
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_dest.id IS NULL THEN
    SELECT * INTO v_dest
    FROM public.payout_destination_verifications
    WHERE user_id = v_uid AND destination_type = 'mobile_money'
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1;
  END IF;

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

COMMENT ON FUNCTION public.payout_withdrawal_block_reasons(uuid) IS
  'Why a withdrawal is blocked, in plain language. Checks user_is_pure_partner then an active id_verification_exceptions row before any identity/destination check -- either one means the user does not need ID verification at all. v_dest is %ROWTYPE (not a bare record) so a user with no identity binding yet still gets a valid, all-NULL v_dest instead of crashing on the first `.id` access on an unassigned record.';
