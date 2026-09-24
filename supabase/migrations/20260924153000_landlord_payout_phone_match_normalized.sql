-- Handover doc 122. Agent reported (2026-09-23 18:34 EAT): landlord number
-- "already verified", OTP verified, but the payout never proceeds.
--
-- Cause: enforce_landlord_payout_eligibility() (doc 112) compared the payout
-- phone to verified_mobile_money_number with an EXACT string match. The
-- 20260922 backfill copied some approved numbers with their original
-- formatting ("0772 363 578"), while issue-landlord-payout-otp stores the
-- on-file string ("0772363578"). Same number; different string -> every
-- payout to that landlord fails after the landlord has already given the OTP.
-- Live: 597 verified landlords have a formatting-only mismatch; one payout
-- (Emilio Odongo, UGX 5,000,000) was blocked by it.
--
-- Fix: compare the subscriber number (landlord_number_norm = last 9 digits,
-- the same normalization the doc-120 lock uses). This still refuses any
-- DIFFERENT number; it only stops spaces / +256 / 0 prefixes from mattering.
-- Doc 120's "don't loosen to normalized" note was wrong for exactly this
-- reason and is corrected in doc 122.

CREATE OR REPLACE FUNCTION public.enforce_landlord_payout_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_landlord_verified boolean;
  v_landlord_phone text;
  v_float_balance numeric;
  v_kampala_hour int;
BEGIN
  IF public.landlord_float_withdrawals_paused() THEN
    RAISE EXCEPTION 'Landlord float withdrawals are currently paused from Platform Controls. Try again once they are re-enabled.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_kampala_hour := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Africa/Kampala'));
  IF v_kampala_hour < 6 OR v_kampala_hour >= 22 THEN
    RAISE EXCEPTION 'Landlord payouts are only allowed between 06:00 and 22:00 Africa/Kampala.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- verified_mobile_money_number (never raw phone/mobile_money_number) is the
  -- only number Landlord Ops actually approved -- see migration 20260922150000.
  SELECT verified, verified_mobile_money_number INTO v_landlord_verified, v_landlord_phone
  FROM public.landlords WHERE id = NEW.landlord_id;

  IF v_landlord_verified IS NOT TRUE THEN
    RAISE EXCEPTION 'Landlord is not verified — Landlord Ops must verify the phone number first.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_landlord_phone IS NULL OR length(public.landlord_number_norm(v_landlord_phone)) < 9 THEN
    RAISE EXCEPTION 'Landlord Ops has not approved a payout number for this landlord.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Structural guarantee, independent of any application code: the phone
  -- actually being paid out to must be the number Landlord Ops approved.
  -- Compared as the subscriber number (last 9 digits) so formatting
  -- ("0772 363 578" vs "0772363578" vs "+256772363578") can't block a payout,
  -- while any different number is still refused (doc 122).
  IF public.landlord_number_norm(NEW.landlord_phone) <> public.landlord_number_norm(v_landlord_phone) THEN
    RAISE EXCEPTION 'Payout phone does not match the number Landlord Ops approved for this landlord.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT balance INTO v_float_balance
  FROM public.agent_landlord_float WHERE agent_id = NEW.agent_id;

  IF v_float_balance IS NULL THEN
    RAISE EXCEPTION 'Agent has no landlord float account.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_float_balance < NEW.amount THEN
    RAISE EXCEPTION 'Insufficient landlord float (balance: %, requested: %).', v_float_balance, NEW.amount
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

INSERT INTO public.critical_function_baselines (function_signature, expected_sha256, note, baselined_at, baselined_by)
SELECT 'enforce_landlord_payout_eligibility()',
       encode(sha256(convert_to(pg_get_functiondef('enforce_landlord_payout_eligibility()'::regprocedure), 'UTF8')), 'hex'),
       'Doc 112/122: last-line gate on landlord_payouts INSERT; payout phone must be the approved number (subscriber-number match).',
       now(), '20260924153000_landlord_payout_phone_match_normalized.sql'
ON CONFLICT (function_signature) DO UPDATE
  SET expected_sha256 = EXCLUDED.expected_sha256,
      baselined_at = now(),
      baselined_by = EXCLUDED.baselined_by,
      note = EXCLUDED.note;
