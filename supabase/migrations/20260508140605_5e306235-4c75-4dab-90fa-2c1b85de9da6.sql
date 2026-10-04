CREATE OR REPLACE FUNCTION public.enforce_no_negative_wallet_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_available numeric := 0;
BEGIN
  IF NEW.ledger_scope IS DISTINCT FROM 'wallet' THEN RETURN NEW; END IF;
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.direction <> 'cash_out' THEN RETURN NEW; END IF;
  IF COALESCE(NEW.classification, '') = 'admin_correction' THEN RETURN NEW; END IF;
  IF COALESCE(NEW.category, '') = 'system_balance_correction' THEN RETURN NEW; END IF;
  IF COALESCE(NEW.category, '') = 'platform_loss_writeoff' THEN RETURN NEW; END IF;

  -- Float-bucket / operational-wallet category debits are not withdrawable spends.
  -- (general_ledger has no recipient_type column; we identify these flows by category.)
  IF COALESCE(NEW.category, '') IN (
    'agent_float_deposit','agent_float_assignment','agent_float_topup',
    'agent_float_funding','rent_float_funding','rent_disbursement'
  ) THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.category, '') IN (
    'wallet_deduction_general_adjustment',
    'wallet_deduction_cash_payout_retraction',
    'wallet_withdrawal',
    'agent_float_used_for_rent',
    'rent_payment_for_tenant',
    'angel_pool_investment'
  ) THEN
    RETURN NEW;
  END IF;

  v_available := COALESCE(public.get_user_available_balance(NEW.user_id), 0);

  IF v_available < NEW.amount THEN
    RAISE EXCEPTION 'NEGATIVE_WALLET_BLOCKED: user % cannot debit % (strict available balance is %)',
      NEW.user_id, NEW.amount, v_available
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;