
CREATE OR REPLACE FUNCTION public.validate_ledger_category()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  allowed_cats text[] := ARRAY[
    'access_fee_collected','registration_fee_collected',
    'wallet_deposit','tenant_repayment','agent_repayment','partner_funding','share_capital',
    'rent_disbursement','rent_receivable_created','rent_principal_collected',
    'roi_expense','roi_wallet_credit','roi_reinvestment',
    'agent_commission_earned','agent_commission_withdrawal','agent_commission_used_for_rent',
    'wallet_withdrawal','wallet_transfer','wallet_deduction',
    'system_balance_correction','orphan_reassignment','orphan_reversal',
    'agent_float_deposit','agent_float_used_for_rent',
    'pending_portfolio_topup',
    'marketing_expense','payroll_expense','general_admin_expense',
    'research_development_expense','tax_expense','interest_expense','equipment_expense'
  ];
  is_strict boolean;
BEGIN
  SELECT strict_mode INTO is_strict FROM public.treasury_controls LIMIT 1;
  IF is_strict IS TRUE AND NEW.category IS NOT NULL AND NOT (NEW.category = ANY(allowed_cats)) THEN
    RAISE EXCEPTION 'Blocked by treasury strict mode: category "%" not in allowlist', NEW.category;
  END IF;
  RETURN NEW;
END;
$$;
