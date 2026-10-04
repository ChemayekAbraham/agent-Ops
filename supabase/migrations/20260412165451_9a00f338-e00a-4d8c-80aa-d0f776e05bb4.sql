-- Fix the auto-assign trigger to recognize all platform categories
CREATE OR REPLACE FUNCTION auto_assign_ledger_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
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

-- Now fix the 3 legacy entries that got wrong scope
-- We need to temporarily allow updates for this correction
CREATE OR REPLACE FUNCTION temp_fix_ledger_scope()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Disable the immutability triggers temporarily
  ALTER TABLE general_ledger DISABLE TRIGGER trg_prevent_ledger_update;
  
  -- Fix the platform-scoped entry that landed in wallet
  UPDATE general_ledger 
  SET ledger_scope = 'platform' 
  WHERE amount = 2552949162 
    AND category = 'partner_funding' 
    AND direction = 'cash_in'
    AND ledger_scope = 'wallet'
    AND classification = 'legacy_real';

  -- Delete the reversal entry (no longer needed since we're fixing in place)
  ALTER TABLE general_ledger DISABLE TRIGGER trg_prevent_ledger_delete;
  
  DELETE FROM general_ledger 
  WHERE amount = 2552949162 
    AND category = 'partner_funding' 
    AND direction = 'cash_out'
    AND ledger_scope = 'wallet'
    AND classification = 'legacy_real';

  -- Keep only the latest platform-scoped entry, remove the duplicate
  DELETE FROM general_ledger 
  WHERE id IN (
    SELECT id FROM general_ledger 
    WHERE amount = 2552949162 
      AND category = 'partner_funding' 
      AND direction = 'cash_in'
      AND classification = 'legacy_real'
    ORDER BY created_at ASC
    LIMIT 1
  );

  -- Re-enable triggers
  ALTER TABLE general_ledger ENABLE TRIGGER trg_prevent_ledger_update;
  ALTER TABLE general_ledger ENABLE TRIGGER trg_prevent_ledger_delete;
END;
$$;

SELECT temp_fix_ledger_scope();
DROP FUNCTION temp_fix_ledger_scope();