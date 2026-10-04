
CREATE OR REPLACE FUNCTION public.validate_ledger_category()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  allowed text[] := ARRAY[
    'access_fee_collected','registration_fee_collected',
    'wallet_deposit','tenant_repayment','agent_repayment','partner_funding','share_capital',
    'rent_disbursement','rent_receivable_created','rent_principal_collected',
    'roi_expense','roi_wallet_credit','roi_reinvestment',
    'agent_commission_earned','agent_commission_withdrawal','agent_commission_used_for_rent',
    'wallet_withdrawal','wallet_transfer','wallet_deduction',
    'system_balance_correction','orphan_reassignment','orphan_reversal',
    'agent_float_deposit','agent_float_used_for_rent','agent_float_assignment','agent_float_settlement',
    'agent_advance_credit',
    'pending_portfolio_topup',
    'marketing_expense','payroll_expense','general_admin_expense','research_development_expense',
    'tax_expense','interest_expense','equipment_expense',
    'partner_commission',
    'debt_recovery'
  ];
  is_strict boolean;
BEGIN
  SELECT COALESCE((SELECT enabled FROM public.treasury_controls WHERE control_key = 'strict_mode' LIMIT 1), false) INTO is_strict;
  IF is_strict AND NOT (NEW.category = ANY(allowed)) THEN
    RAISE EXCEPTION 'Category "%" is not in the locked allowlist', NEW.category;
  END IF;
  RETURN NEW;
END;
$$;
