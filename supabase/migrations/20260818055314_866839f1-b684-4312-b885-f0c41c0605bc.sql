CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY[
    '🔧 Manual Adjustment','access_fee_collected','account_merge','advance_repayment',
    'agent_advance_credit','agent_advance_repayment','agent_bonus','agent_commission',
    'agent_commission_earned','agent_commission_payable','agent_commission_used_for_rent',
    'agent_commission_withdrawal','agent_float_assignment','agent_float_deposit',
    'agent_float_funding','agent_float_settlement','agent_float_topup','agent_float_used',
    'agent_float_used_for_rent','agent_investment_commission','agent_landlord_payout',
    'agent_proxy_investment','agent_repayment','angel_pool_investment','balance_correction',
    'cfo_direct_credit','coo_proxy_investment','coo_proxy_investment_reversal',
    'correction_reversal','credit_access_repayment','debt_clearance','debt_recovery','deposit',
    'equipment_expense','general_admin_expense','historical_balance_reseed','interest_expense',
    'landlord_rent_payment','listing_bonus','listing_bonus_expense','listing_rejection_offset',
    'listing_rejection_penalty','listing_rejection_recovery','manager_credit','manager_debit',
    'marketing_expense','merchant_float_correction_writedown','orphan_reassignment',
    'orphan_reversal','partner_commission','partner_funding','payroll_expense',
    'pending_portfolio_topup','platform_expense','platform_loss_writeoff',
    'pool_capital_received','pool_rent_deployment_reversal','proxy_investment_commission',
    'proxy_partner_withdrawal','reconciliation','referral_bonus','registration_fee_collected',
    'rent_disbursement','rent_float_funding','rent_obligation','rent_obligation_reversal',
    'rent_obligation_reversal_adjustment','rent_payment_for_tenant','rent_payment_received',
    'rent_principal_collected','rent_receivable_created','rent_repayment',
    'research_development_expense','roi_expense','roi_payout','roi_reinvestment',
    'roi_wallet_credit','salary_advance','salary_advance_repayment','salary_payout',
    'share_capital','supporter_capital','supporter_rent_fund','system_balance_correction',
    'tax_expense','tenant_default_charge','tenant_repayment','test_funds_cleanup',
    'wallet_deduction','wallet_deduction_cash_payout_retraction',
    'wallet_deduction_general_adjustment','wallet_deposit','wallet_to_investment',
    'wallet_transfer','wallet_withdrawal',
    'cash_receipt_in_transit','cash_at_bank_reclass','cash_in_transit_banked',
    'treasury_bank_deposit',
    -- Financial Ops physical cash receipt counter-legs
    'cash_custody_payable','agent_float_cash_offset',
    -- Historical partner funding cash recognition
    'partner_capital_cash_received','agent_facilitated_capital_receivable'
  ]::text[];
$function$;

INSERT INTO public.ledger_account_map (category, ledger_scope, account_code, debit_when)
SELECT 'partner_capital_cash_received', 'platform', 'A1', 'cash_out'
WHERE NOT EXISTS (
  SELECT 1 FROM public.ledger_account_map
  WHERE category = 'partner_capital_cash_received' AND ledger_scope = 'platform'
);

INSERT INTO public.ledger_account_map (category, ledger_scope, account_code, debit_when)
SELECT 'agent_facilitated_capital_receivable', 'platform', 'A2', 'cash_out'
WHERE NOT EXISTS (
  SELECT 1 FROM public.ledger_account_map
  WHERE category = 'agent_facilitated_capital_receivable' AND ledger_scope = 'platform'
);