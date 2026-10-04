-- =========================================================================
-- Fix Missing Ledger Categories (Commissions Bug)
-- Replaces validate_ledger_category to include all valid routed categories
-- =========================================================================

CREATE OR REPLACE FUNCTION public.validate_ledger_category()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  allowed text[] := ARRAY[
    -- Core System & Administration
    'system_balance_correction','balance_correction','reconciliation',
    'orphan_reassignment','orphan_reversal','correction_reversal','account_merge',
    'historical_balance_reseed','platform_loss_writeoff',
    'test_funds_cleanup','🔧 Manual Adjustment',
    
    -- Deposits & Withdrawals
    'wallet_deposit','deposit','wallet_withdrawal','wallet_transfer','wallet_deduction',
    'wallet_deduction_general_adjustment','wallet_deduction_cash_payout_retraction',
    'cfo_direct_credit','manager_credit','manager_debit',
    
    -- Rent & Tenant Operations
    'rent_principal_collected','rent_disbursement','rent_receivable_created',
    'rent_payment_for_tenant','rent_obligation','tenant_default_charge',
    'rent_obligation_reversal','rent_obligation_reversal_adjustment',
    'tenant_repayment','rent_repayment','landlord_rent_payment',
    'pool_rent_deployment_reversal',
    
    -- Agent Float Operations
    'agent_float_deposit','agent_float_assignment','agent_float_topup',
    'agent_float_funding','agent_float_used_for_rent','agent_float_used',
    'agent_float_settlement','agent_landlord_payout','rent_float_funding',
    
    -- Commissions & Bonuses
    'agent_commission_earned','agent_commission','agent_bonus',
    'partner_commission','referral_bonus','proxy_investment_commission',
    'agent_investment_commission',
    'agent_commission_withdrawal','agent_commission_used_for_rent',
    
    -- Advances & Debt
    'agent_advance_credit','salary_advance',
    'agent_advance_repayment','salary_advance_repayment',
    'advance_repayment','debt_recovery','debt_clearance','credit_access_repayment',
    'agent_repayment',
    
    -- Investments, ROI & Funding
    'partner_funding','share_capital','supporter_capital','supporter_rent_fund',
    'pool_capital_received','roi_expense','roi_wallet_credit','roi_reinvestment',
    'roi_payout','agent_proxy_investment','coo_proxy_investment',
    'angel_pool_investment','wallet_to_investment','pending_portfolio_topup',
    'proxy_partner_withdrawal','coo_proxy_investment_reversal',
    
    -- Fees & Platform Income
    'access_fee_collected','registration_fee_collected',
    
    -- General Platform Expenses
    'marketing_expense','payroll_expense','general_admin_expense',
    'research_development_expense','tax_expense','interest_expense',
    'equipment_expense','platform_expense','salary_payout'
  ];
  is_strict boolean;
BEGIN
  SELECT COALESCE((SELECT enabled FROM public.treasury_controls WHERE control_key = 'strict_mode' LIMIT 1), false) INTO is_strict;
  IF is_strict AND NOT (NEW.category = ANY(allowed)) THEN
    RAISE EXCEPTION 'Category "%" is not in the locked allowlist', NEW.category;
  END IF;
  RETURN NEW;
END;
$function$;
