CREATE OR REPLACE FUNCTION public.enforce_no_negative_wallet_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_available numeric := 0;
BEGIN
  IF NEW.ledger_scope IS DISTINCT FROM 'wallet' THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.direction <> 'cash_out' THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.classification, '') = 'admin_correction' THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.category, '') = 'system_balance_correction' THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.category, '') = 'platform_loss_writeoff' THEN
    RETURN NEW;
  END IF;

  -- Float-bucket / operational-wallet debits are NOT withdrawable spends.
  -- They are validated against wallets.float_balance inside their own RPC
  -- (e.g. agent_allocate_tenant_payment). Recipient_type=operational_wallet
  -- AND/OR these category names indicate a float movement, not a withdrawable
  -- one — so this trigger (which measures the withdrawable bucket) must skip.
  IF COALESCE(NEW.recipient_type, '') = 'operational_wallet' THEN
    RETURN NEW;
  END IF;

  -- Existing special-case flows perform their own approval/solvency gates.
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