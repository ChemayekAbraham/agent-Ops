CREATE OR REPLACE FUNCTION public.enforce_kyc_withdrawal_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_has_recent_deposit boolean := false;
BEGIN
  IF NEW.user_id IS NULL OR NEW.amount IS NULL OR NEW.amount <= 0 THEN
    RETURN NEW;
  END IF;

  -- Landlord float payouts bypass (float already deducted upstream).
  IF NEW.landlord_payout_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Proxy-agent withdrawals on behalf of a proxy partner bypass the rule.
  IF NEW.proxy_partner_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Weekly KYC rule: user must have deposited money to their wallet
  -- within the last 7 days. Accepts any wallet inflow tagged as a real
  -- deposit, or an approved/completed/confirmed deposit_requests row.
  SELECT EXISTS (
    SELECT 1 FROM public.general_ledger
    WHERE user_id = NEW.user_id
      AND ledger_scope = 'wallet'
      AND direction = 'cash_in'
      AND category IN ('wallet_deposit','agent_float_deposit')
      AND created_at >= now() - interval '7 days'
  ) OR EXISTS (
    SELECT 1 FROM public.deposit_requests
    WHERE user_id = NEW.user_id
      AND status IN ('approved','completed','confirmed')
      AND COALESCE(updated_at, created_at) >= now() - interval '7 days'
  )
  INTO v_has_recent_deposit;

  IF NOT v_has_recent_deposit THEN
    RAISE EXCEPTION 'Weekly deposit required before you can withdraw. Fund your wallet at least once every 7 days, then try again.'
      USING ERRCODE = 'check_violation', HINT = 'deposit_required_weekly';
  END IF;

  RETURN NEW;
END;
$function$;