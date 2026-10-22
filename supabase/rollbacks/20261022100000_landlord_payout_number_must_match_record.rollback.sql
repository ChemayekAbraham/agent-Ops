-- Rollback for 20261022100000_landlord_payout_number_must_match_record.sql
-- Restores enforce_landlord_payout_eligibility() to the version that checks only the approved number. After this, a payout to an approved number
-- that differs from the landlord's record is no longer refused. confirm_landlord_payout_number() keeps the stricter rule (harmless on its own).
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

