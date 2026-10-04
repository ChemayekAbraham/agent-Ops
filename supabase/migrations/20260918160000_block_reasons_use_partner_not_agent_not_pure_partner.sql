-- payout_withdrawal_block_reasons() short-circuits to blocked=false for
-- user_is_pure_partner(v_uid), but that is NOT the check that actually
-- decides whether a withdrawal will succeed. ensure_payout_destination()
-- -- called from submit_withdrawal_request(), the RPC that actually creates
-- the withdrawal_requests row -- only auto-verifies a destination for
-- is_partner_not_agent(v_uid). The two functions are deliberately different
-- (20260916170000 / doc 40): is_partner_not_agent also excludes anyone who
-- shows up in rent_requests.agent_id/assigned_agent_id/proxy_agent_id;
-- user_is_pure_partner only excludes agent_collections. A user can be a
-- "pure partner" by the looser definition while having done proxy/assigned
-- agent work by the stricter one -- exactly LUKODDA JOSEPH's case.
--
-- Found investigating "Lukodda Joseph is denied withdrawal, yet he has an
-- ID on file" (b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c): user_is_pure_partner
-- = true, is_partner_not_agent = false. payout_withdrawal_block_reasons
-- told the Withdraw screen he was blocked=false / status=verified -- but
-- none of his ~30 payout_destination_verifications rows has ever been
-- auto-verified (ensure_payout_destination correctly refuses, since he is
-- not partner_not_agent), he has no user_identity_bindings row, and his
-- national_id is on file with no photos. submit_withdrawal_request
-- therefore rejects every attempt with destination_unverified -- a
-- confusing outcome given the Withdraw screen had just told him he was
-- clear. This is doc 40's exact failure mode in reverse: instead of the
-- advisory function being too strict, it was too lenient, disagreeing with
-- the gate that actually decides the outcome.
--
-- Fix: check is_partner_not_agent instead of user_is_pure_partner, so this
-- function agrees with ensure_payout_destination/submit_withdrawal_request
-- -- the functions that actually move money -- instead of a looser,
-- unrelated definition. Verified this does not regress the four accounts
-- doc 40 fixed (Simon Kavuma, Elvis Opio, okee samuel, MARVIN SSEMBATYA):
-- both functions already agree (true/true) for all four.

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

  IF public.is_partner_not_agent(v_uid) THEN
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
  'Why a withdrawal is blocked, in plain language. Checks is_partner_not_agent (the same exemption ensure_payout_destination uses to auto-verify a destination -- NOT user_is_pure_partner, a looser, different check) then an active id_verification_exceptions row before any identity/destination check. v_dest is %ROWTYPE (not a bare record) so a user with no identity binding yet still gets a valid, all-NULL v_dest instead of crashing on the first `.id` access on an unassigned record.';
