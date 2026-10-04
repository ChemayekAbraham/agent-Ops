CREATE OR REPLACE FUNCTION public.enforce_no_fraud_withdrawal_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_frozen boolean := false;
  v_reason text;
BEGIN
  IF TG_OP <> 'INSERT' AND NEW.status NOT IN ('pending','requested','manager_approved','processing','completed','approved') THEN
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
$$;

DROP TRIGGER IF EXISTS trg_enforce_no_fraud_withdrawal_request ON public.withdrawal_requests;
CREATE TRIGGER trg_enforce_no_fraud_withdrawal_request
BEFORE INSERT OR UPDATE OF status, user_id, mobile_money_number ON public.withdrawal_requests
FOR EACH ROW
EXECUTE FUNCTION public.enforce_no_fraud_withdrawal_request();