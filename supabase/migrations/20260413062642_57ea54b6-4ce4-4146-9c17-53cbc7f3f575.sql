CREATE OR REPLACE FUNCTION auto_assign_ledger_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- If ledger_scope is already explicitly set by the caller, respect it
  IF NEW.ledger_scope IS NOT NULL AND NEW.ledger_scope IN ('wallet', 'platform', 'bridge') THEN
    RETURN NEW;
  END IF;

  -- Platform-only categories (revenue, expenses, system)
  IF NEW.category IN (
    'access_fee_collected',
    'registration_fee_collected',
    'partner_funding',
    'share_capital',
    'rent_disbursement',
    'rent_receivable_created',
    'rent_principal_collected',
    'roi_expense',
    'roi_wallet_credit',
    'roi_reinvestment',
    'agent_commission_earned',
    'agent_commission_withdrawal',
    'agent_commission_used_for_rent',
    'wallet_deduction',
    'system_balance_correction',
    'orphan_reassignment',
    'orphan_reversal',
    'pool_rent_deployment',
    'platform_service_income',
    'agent_commission_payout',
    'supporter_platform_rewards',
    'transaction_platform_expenses',
    'operational_expenses',
    'opening_balance'
  ) THEN
    NEW.ledger_scope := 'platform';
  -- Bridge categories
  ELSIF NEW.category IN (
    'supporter_facilitation_capital',
    'rent_facilitation_payout',
    'agent_commission'
  ) THEN
    NEW.ledger_scope := 'bridge';
  ELSE
    -- Default: wallet scope (deposits, withdrawals, transfers, etc.)
    NEW.ledger_scope := 'wallet';
  END IF;
  RETURN NEW;
END;
$$;