CREATE OR REPLACE FUNCTION public.enforce_no_fraud_wallet_earnings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_frozen boolean := false;
BEGIN
  IF NEW.ledger_scope <> 'wallet'
     OR NEW.user_id IS NULL
     OR NEW.direction NOT IN ('cash_in','credit')
     OR NEW.category NOT IN (
       'agent_commission',
       'agent_commission_earned',
       'partner_commission',
       'referral_bonus',
       'recruiter_override_bonus',
       'tenant_placement_bonus'
     ) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(is_frozen, false)
    INTO v_frozen
  FROM public.profiles
  WHERE id = NEW.user_id;

  IF v_frozen OR public.is_fraud_identifier_blocked('user_id', NEW.user_id::text) THEN
    RAISE EXCEPTION 'fraud_blocked_wallet_credit: this account is restricted and cannot receive earning credits'
      USING ERRCODE = '28000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_no_fraud_wallet_earnings ON public.general_ledger;
CREATE TRIGGER trg_enforce_no_fraud_wallet_earnings
BEFORE INSERT ON public.general_ledger
FOR EACH ROW
EXECUTE FUNCTION public.enforce_no_fraud_wallet_earnings();