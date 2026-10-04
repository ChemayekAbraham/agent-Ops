CREATE OR REPLACE FUNCTION public.enforce_kyc_withdrawal_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_has_deposit boolean := false;
BEGIN
  IF NEW.user_id IS NULL OR NEW.amount IS NULL OR NEW.amount <= 0 THEN
    RETURN NEW;
  END IF;

  -- Landlord float payouts bypass (float already deducted upstream).
  IF NEW.landlord_payout_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Proxy-agent withdrawals on behalf of a proxy partner bypass the
  -- "must have deposited first" rule: the partner (user_id) may never
  -- personally deposit — funds arrive via the proxy agent, and the
  -- managed-proxy routing rules already gate the money movement.
  IF NEW.proxy_partner_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Interim rule: user must have EVER deposited money to their wallet.
  -- Accepts any wallet inflow tagged as a real deposit, or an approved
  -- deposit_requests row.
  SELECT EXISTS (
    SELECT 1 FROM public.general_ledger
    WHERE user_id = NEW.user_id
      AND ledger_scope = 'wallet'
      AND direction = 'cash_in'
      AND category IN ('wallet_deposit','agent_float_deposit')
  ) OR EXISTS (
    SELECT 1 FROM public.deposit_requests
    WHERE user_id = NEW.user_id
      AND status IN ('approved','completed','confirmed')
  )
  INTO v_has_deposit;

  IF NOT v_has_deposit THEN
    RAISE EXCEPTION 'Deposit required before you can withdraw. Fund your wallet first, then try again.'
      USING ERRCODE = 'check_violation', HINT = 'deposit_required';
  END IF;

  RETURN NEW;
END;
$function$;