-- Bug: "USER CANNOT WITHDRAW EVEN AFTER RESUBMITTING HIS DETAILS" — screenshot
-- showed the exact rejection text for momo 0700212384 ("registered to OCHIENG
-- CHARLES WILFRED"). Traced to Grace Paul Ochieng (99890a2e-b842-4d44-8516-
-- e2eafe0711ff): she had already switched to her own MTN number (0787373498),
-- and Financial Ops had *approved* it ("VERIFIES USER 101", verified at
-- 2026-09-16 08:35) — yet the withdraw screen kept showing the same old
-- rejected-third-party-number banner. Confirmed live against production.
--
-- Two independent bugs found, both fixed here:
--
-- 1. payout_withdrawal_block_reasons() ordered candidate destinations by
--    `(status = 'rejected') DESC, updated_at DESC` — i.e. ANY rejected
--    mobile_money destination outranks a newer verified one, no matter how
--    stale. Grace has 11 old rejected junk destinations (test numbers, other
--    people's momo) sitting next to her freshly-verified real one; the
--    reject-first tiebreak picked one of the old ones every time. Fix: order
--    by updated_at alone, so whichever destination the user (or Financial
--    Ops) most recently touched is the one that governs the block state.
--
-- 2. ensure_payout_destination()'s UPDATE branch only ever transitions
--    'verified' -> 'waiting' (identity drift) or 'waiting' -> 'verified'
--    (partner exemption). There was no case for 'rejected' at all, so a user
--    who resubmits the SAME destination_key after a rejection (re-confirms
--    the same number via OTP, e.g. after the real owner grants consent) gets
--    their row's account_name/name_match_score refreshed but the status
--    silently stays 'rejected' forever — even though the rejection text
--    itself promises "submit again and Financial Ops will look at it." Fix:
--    reopen a rejected destination to 'waiting' on resubmission. This is
--    safe: finops_decide_payout_destination() re-runs the double-submission
--    and duplicate-National-ID auto-reject checks before it will ever accept
--    'verified' again, so a genuinely fraudulent resubmission still bounces
--    back to rejected at decision time.

CREATE OR REPLACE FUNCTION public.ensure_payout_destination(p_user_id uuid, p_method text, p_momo_number text DEFAULT NULL::text, p_momo_name text DEFAULT NULL::text, p_provider text DEFAULT NULL::text, p_bank_name text DEFAULT NULL::text, p_bank_account_number text DEFAULT NULL::text, p_bank_account_name text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, status text, decision_reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key text := public.payout_destination_key(p_method, p_momo_number, p_bank_name, p_bank_account_number);
  v_type text := CASE WHEN lower(coalesce(p_method,'')) = 'mobile_money' THEN 'mobile_money' ELSE 'bank_transfer' END;
  v_name text := coalesce(nullif(btrim(coalesce(p_momo_name,'')), ''), nullif(btrim(coalesce(p_bank_account_name,'')), ''));
  v_id uuid;
  v_status text;
  v_reason text;
  v_prev_name text;
  v_id_name text;
  v_nid text;
  v_report jsonb;
  v_still_matches boolean;
  v_exempt boolean := public.is_partner_not_agent(p_user_id);
BEGIN
  IF v_key IS NULL THEN
    RETURN;
  END IF;

  SELECT p.national_id, coalesce(p.national_id_name, p.full_name)
    INTO v_nid, v_id_name
  FROM public.profiles p WHERE p.id = p_user_id;

  v_report := public.payout_name_match_report(v_id_name, v_name);
  -- A perfect (or unscored, e.g. no ID on file yet) match never re-opens a
  -- verified destination; only a genuine mismatch against the ID does.
  v_still_matches := (v_report->>'score') IS NULL OR (v_report->>'score')::numeric >= 1;

  SELECT d.id, d.status, d.account_name INTO v_id, v_status, v_prev_name
  FROM public.payout_destination_verifications d
  WHERE d.user_id = p_user_id AND d.destination_key = v_key;

  IF v_id IS NULL THEN
    INSERT INTO public.payout_destination_verifications (
      user_id, destination_type, destination_key, provider,
      momo_number, bank_name, bank_account_number, account_name,
      national_id, national_id_name, name_match_score, name_mismatch_tokens,
      status, decision_reason
    ) VALUES (
      p_user_id, v_type, v_key,
      CASE WHEN v_type = 'mobile_money' THEN lower(coalesce(p_provider,'')) ELSE 'bank' END,
      CASE WHEN v_type = 'mobile_money' THEN btrim(p_momo_number) END,
      CASE WHEN v_type = 'bank_transfer' THEN btrim(p_bank_name) END,
      CASE WHEN v_type = 'bank_transfer' THEN btrim(p_bank_account_number) END,
      v_name, v_nid, v_id_name,
      (v_report->>'score')::numeric, coalesce(v_report->'diff', '[]'::jsonb),
      CASE WHEN v_exempt THEN 'verified' ELSE 'waiting' END,
      CASE WHEN v_exempt THEN 'Auto-verified: partner with no agent activity is exempt from manual payout-destination verification.' ELSE NULL END
    )
    RETURNING payout_destination_verifications.id, payout_destination_verifications.status,
              payout_destination_verifications.decision_reason
      INTO v_id, v_status, v_reason;
  ELSE
    UPDATE public.payout_destination_verifications d
    SET account_name = coalesce(v_name, d.account_name),
        national_id = coalesce(v_nid, d.national_id),
        national_id_name = coalesce(v_id_name, d.national_id_name),
        name_match_score = (v_report->>'score')::numeric,
        name_mismatch_tokens = coalesce(v_report->'diff', '[]'::jsonb),
        status = CASE
          WHEN v_exempt AND d.status = 'waiting' THEN 'verified'
          WHEN d.status = 'verified'
               AND v_name IS NOT NULL
               AND NOT v_still_matches
               AND NOT v_exempt THEN 'waiting'
          WHEN d.status = 'rejected' AND NOT v_exempt THEN 'waiting'
          ELSE d.status END,
        decision_reason = CASE
          WHEN v_exempt AND d.status = 'waiting' THEN 'Auto-verified: partner with no agent activity is exempt from manual payout-destination verification.'
          WHEN d.status = 'verified'
               AND v_name IS NOT NULL
               AND NOT v_still_matches
               AND NOT v_exempt
          THEN 'Registered name no longer matches the verified identity — needs re-verification'
          WHEN d.status = 'rejected' AND NOT v_exempt
          THEN 'Resubmitted after rejection — needs Financial Ops re-review.'
          ELSE d.decision_reason END
    WHERE d.id = v_id
    RETURNING d.status, d.decision_reason INTO v_status, v_reason;
  END IF;

  RETURN QUERY SELECT v_id, v_status, v_reason;
END;
$function$;

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

  SELECT national_id, linked_national_id, national_id_photo_path, national_id_back_photo_path,
         selfie_photo_path, mobile_money_number, mobile_money_name
    INTO v_p
  FROM public.profiles WHERE id = v_uid;

  SELECT * INTO v_binding
  FROM public.user_identity_bindings
  WHERE user_id = v_uid AND status <> 'revoked' AND coalesce(locked_payout_number, '') <> '';

  -- Most-recently-touched destination wins, regardless of status. A user
  -- with several stale rejected destinations (old numbers, test entries)
  -- and one freshly verified/waiting one must not have the stale reject
  -- outrank the current, more recent state.
  SELECT * INTO v_dest
  FROM public.payout_destination_verifications
  WHERE user_id = v_uid AND destination_type = 'mobile_money'
  ORDER BY updated_at DESC NULLS LAST
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
