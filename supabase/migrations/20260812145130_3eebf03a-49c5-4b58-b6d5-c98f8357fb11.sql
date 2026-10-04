CREATE OR REPLACE FUNCTION public.enforce_no_fraud_withdrawal_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_frozen boolean := false;
  v_reason text;
BEGIN
  IF TG_OP <> 'INSERT' AND NEW.status NOT IN ('pending','requested','manager_approved','processing','completed','approved') THEN
    RETURN NEW;
  END IF;

  -- Book-closing exception: a payout that was already delivered may be marked
  -- complete even for a restricted account, PROVIDED no money detail changes.
  -- This moves no funds; it only records what already happened.
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'processing'
     AND NEW.status = 'completed'
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.amount IS NOT DISTINCT FROM OLD.amount
     AND NEW.mobile_money_number IS NOT DISTINCT FROM OLD.mobile_money_number THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(is_frozen, false), frozen_reason
    INTO v_frozen, v_reason
  FROM public.profiles
  WHERE id = NEW.user_id;

  IF v_frozen OR public.is_fraud_identifier_blocked('user_id', NEW.user_id::text) THEN
    RAISE EXCEPTION 'fraud_blocked_withdrawal: this account is restricted and cannot request or receive withdrawals'
      USING ERRCODE = '28000';
  END IF;

  IF NEW.mobile_money_number IS NOT NULL AND (
    public.is_fraud_identifier_blocked('phone', NEW.mobile_money_number)
    OR public.is_fraud_identifier_blocked('mobile_money_number', NEW.mobile_money_number)
  ) THEN
    RAISE EXCEPTION 'fraud_blocked_withdrawal_destination: this payout number is restricted'
      USING ERRCODE = '28000';
  END IF;

  RETURN NEW;
END;
$function$;