CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY[
    'access_fee_collected','registration_fee_collected',
    'wallet_deposit','tenant_repayment','agent_repayment','partner_funding','share_capital',
    'rent_disbursement','rent_receivable_created','rent_principal_collected',
    'rent_payment_for_tenant','rent_payment_received',
    'roi_expense','roi_wallet_credit','roi_reinvestment',
    'agent_commission_earned','agent_commission_withdrawal','agent_commission_used_for_rent',
    'agent_commission_payable',
    'wallet_withdrawal','wallet_transfer','wallet_deduction',
    'system_balance_correction','orphan_reassignment','orphan_reversal',
    'agent_float_deposit','agent_float_used_for_rent','agent_float_assignment','agent_float_settlement',
    'agent_float_topup','agent_float_funding','agent_float_used','rent_float_funding',
    'agent_advance_credit','agent_advance_repayment','salary_advance','salary_advance_repayment',
    'pending_portfolio_topup',
    'marketing_expense','payroll_expense','general_admin_expense','research_development_expense',
    'tax_expense','interest_expense','equipment_expense',
    'partner_commission','debt_recovery',
    'historical_balance_reseed','platform_loss_writeoff',
    'wallet_deduction_general_adjustment','wallet_deduction_cash_payout_retraction',
    'angel_pool_investment','pool_capital_received','wallet_to_investment',
    'deposit','cfo_direct_credit','agent_commission','agent_bonus','referral_bonus',
    'proxy_investment_commission','agent_investment_commission','salary_payout',
    'roi_payout','manager_credit','supporter_capital','supporter_rent_fund',
    'landlord_rent_payment','rent_repayment','credit_access_repayment',
    'balance_correction','reconciliation','correction_reversal','account_merge',
    'rent_obligation_reversal','rent_obligation_reversal_adjustment',
    'pool_rent_deployment_reversal','coo_proxy_investment_reversal',
    'debt_clearance','rent_obligation','tenant_default_charge','advance_repayment',
    'manager_debit','agent_proxy_investment','coo_proxy_investment',
    'proxy_partner_withdrawal','test_funds_cleanup','platform_expense',
    'agent_landlord_payout','🔧 Manual Adjustment',
    'listing_bonus','listing_bonus_expense',
    'listing_rejection_penalty','listing_rejection_recovery'
  ];
$function$;