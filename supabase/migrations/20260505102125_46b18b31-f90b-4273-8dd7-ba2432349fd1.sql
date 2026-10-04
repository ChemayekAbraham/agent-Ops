CREATE OR REPLACE FUNCTION public.enforce_no_negative_wallet_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_net numeric;
BEGIN
  -- Only inspect outbound, user-attributed, production wallet rows.
  IF NEW.ledger_scope IS DISTINCT FROM 'wallet' THEN RETURN NEW; END IF;
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.direction <> 'cash_out' THEN RETURN NEW; END IF;
  IF COALESCE(NEW.classification,'') = 'admin_correction' THEN RETURN NEW; END IF;
  IF NEW.category = 'system_balance_correction' THEN RETURN NEW; END IF;
  -- Allow the reconciliation pair itself.
  IF NEW.category = 'platform_loss_writeoff' THEN RETURN NEW; END IF;

  -- CFO/FinOps wallet recovery path: these deductions are already guarded by
  -- the wallet-deduction Edge Function against the live wallet bucket. Do not
  -- block them because of older strict-ledger drift.
  IF NEW.category IN (
    'wallet_deduction_general_adjustment',
    'wallet_deduction_cash_payout_retraction'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END), 0)
    INTO v_net
    FROM public.general_ledger
    WHERE user_id = NEW.user_id
      AND ledger_scope = 'wallet'
      AND classification <> 'admin_correction'
      AND category <> 'system_balance_correction';

  IF v_net - NEW.amount < 0 THEN
    RAISE EXCEPTION 'NEGATIVE_WALLET_BLOCKED: user % cannot debit % (strict ledger balance is %)',
      NEW.user_id, NEW.amount, v_net
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;