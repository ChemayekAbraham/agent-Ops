CREATE OR REPLACE FUNCTION public.enforce_no_negative_wallet_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_available numeric := 0;
  v_float numeric := 0;
BEGIN
  IF NEW.ledger_scope IS DISTINCT FROM 'wallet' THEN RETURN NEW; END IF;
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.direction <> 'cash_out' THEN RETURN NEW; END IF;
  IF COALESCE(NEW.classification, '') = 'admin_correction' THEN RETURN NEW; END IF;
  IF COALESCE(NEW.category, '') = 'system_balance_correction' THEN RETURN NEW; END IF;
  IF COALESCE(NEW.category, '') = 'platform_loss_writeoff' THEN RETURN NEW; END IF;

  -- Routing v2: if the leg is explicitly addressed to the operational wallet
  -- (float bucket), it is NOT a withdrawable spend. Gate against float balance
  -- instead of the strict withdrawable balance.
  IF COALESCE(NEW.recipient_type, '') = 'operational_wallet'
     OR COALESCE(NEW.wallet_bucket, '') = 'float' THEN
    SELECT COALESCE(float_balance, 0) INTO v_float
    FROM public.wallets WHERE user_id = NEW.user_id;
    IF v_float < NEW.amount THEN
      RAISE EXCEPTION 'NEGATIVE_FLOAT_BLOCKED: user % cannot debit % from float (float balance is %)',
        NEW.user_id, NEW.amount, v_float
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Legacy float-category bypass list (unchanged)
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
$$;