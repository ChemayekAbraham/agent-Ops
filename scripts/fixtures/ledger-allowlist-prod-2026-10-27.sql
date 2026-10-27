-- Verbatim production copies (2026-10-27, read-only export via pg_get_functiondef, project byrzshwlentqvktcksem) of the
-- ledger category allowlist that Special Advances Phase 4 extends. Production's live allowlist matches no repo migration,
-- so the Phase 4 tests load these instead of an older repo version.
--   ledger_category_allowlist()       md5(prosrc) 736744d355fe913acfcc0593204613a6  config ["search_path=public, extensions, pg_temp"]  (178 categories)
--   ledger_category_allowlist_base()  md5(prosrc) 8270ad0ea82af904767ff6cba4c26f18
-- Phase 4's preflight refuses unless the live allowlist still has exactly this fingerprint and configuration.

CREATE OR REPLACE FUNCTION public.ledger_category_allowlist_base()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$ select array['🔧 Manual Adjustment', 'access_fee_collected', 'account_merge', 'advance_repayment', 'agent_advance_credit', 'agent_advance_repayment', 'agent_bonus', 'agent_commission', 'agent_commission_accrued', 'agent_commission_earned', 'agent_commission_payable', 'agent_commission_settled', 'agent_commission_used_for_rent', 'agent_commission_withdrawal', 'agent_facilitated_capital_receivable', 'agent_float_assignment', 'agent_float_cash_offset', 'agent_float_cycle_settled_to_bank', 'agent_float_deposit', 'agent_float_funding', 'agent_float_settlement', 'agent_float_topup', 'agent_float_used', 'agent_float_used_for_rent', 'agent_investment_commission', 'agent_landlord_payout', 'agent_proxy_investment', 'agent_repayment', 'angel_pool_investment', 'balance_correction', 'bucket_reclass_in', 'bucket_reclass_out', 'cash_at_bank_reclass', 'cash_custody_payable', 'cash_in_transit_banked', 'cash_receipt_in_transit', 'cfo_direct_credit', 'coo_proxy_investment', 'coo_proxy_investment_reversal', 'correction_reversal', 'credit_access_repayment', 'debt_clearance', 'debt_recovery', 'deposit', 'equipment_expense', 'facilitation_disbursement', 'fee_receivable_created', 'general_admin_expense', 'historical_balance_reseed', 'interest_expense', 'landlord_receivable_collected', 'landlord_receivable_created', 'landlord_receivable_obligation', 'landlord_rent_payment', 'listing_bonus', 'listing_bonus_expense', 'listing_rejection_offset', 'listing_rejection_penalty', 'listing_rejection_recovery', 'manager_credit', 'manager_debit', 'marketing_expense', 'merchant_float_correction_writedown', 'merchant_oop_reimbursement', 'orphan_reassignment', 'orphan_reversal', 'partner_capital_cash_received', 'partner_commission', 'partner_funding', 'partner_receivable_capital', 'partner_receivable_collected', 'partner_receivable_created', 'partner_reward_accrued', 'partner_returns_allocated', 'platform_fee_collected', 'payroll_expense', 'pending_portfolio_topup', 'platform_expense', 'platform_loss_writeoff', 'pool_capital_received', 'pool_rent_deployment_reversal', 'proxy_investment_commission', 'proxy_partner_withdrawal', 'reconciliation', 'referral_bonus', 'registration_fee_collected', 'rent_disbursement', 'rent_float_funding', 'rent_obligation', 'rent_obligation_reversal', 'rent_obligation_reversal_adjustment', 'rent_payment_for_tenant', 'rent_payment_received', 'rent_principal_collected', 'rent_receivable_created', 'rent_repayment', 'research_development_expense', 'roi_expense', 'roi_payout', 'roi_reinvestment', 'roi_wallet_credit', 'salary_advance', 'salary_advance_repayment', 'salary_payout', 'share_capital', 'staff_loan_disbursement', 'staff_loan_repayment', 'supporter_capital', 'supporter_rent_fund', 'system_balance_correction', 'tax_expense', 'tenant_default_charge', 'tenant_rent_settlement', 'tenant_repayment', 'tenant_repayment_collected', 'test_funds_cleanup', 'treasury_allocated', 'treasury_bank_deposit', 'treasury_fee_drawdown', 'treasury_fee_recognised', 'treasury_net_revenue', 'verified_bank_cash_recognised', 'wallet_deduction', 'wallet_deduction_cash_payout_retraction', 'wallet_deduction_general_adjustment', 'wallet_deposit', 'wallet_to_investment', 'wallet_transfer', 'wallet_withdrawal']::text[] $function$;

CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT public.ledger_category_allowlist_base() || ARRAY[
    'agent_advance_receivable_opening',
    'agent_access_fee_receivable_opening',
    'merchandise_recovery_receivable_opening',
    'bike_recovery_receivable_opening',
    'credit_draw_receivable_opening',
    'merchandise_credit_sale_receivable_opening',
    'service_centre_advance_receivable_opening',
    'service_centre_receivable_opening',
    'tenant_service_charge_receivable_opening',
    'business_advance_receivable_opening',
    'rent_plan_receivable_restatement',
    'receivable_restatement_equity',
    'merchandise_recovery_repayment',
    'bike_recovery_repayment',
    'credit_draw_repayment',
    'smartphone_advance_receivable',
    'agent_advance_disbursement',
    'agent_advance_access_fee_charged',
    'agent_advance_registration_fee_charged',
    'agent_advance_fee_revenue',
    'agent_advance_penalty_accrued',
    'agent_advance_penalty_unearned',
    'agent_advance_access_fee_collected',
    'agent_advance_registration_fee_collected',
    'agent_advance_written_off',
    'agent_advance_access_fee_written_off',
    'agent_advance_registration_fee_written_off',
    'agent_advance_reversed',
    'agent_advance_clawback',
    'agent_advance_late_fee_income',
    'agent_advance_access_fee_collected_external',
    'agent_advance_registration_fee_collected_external',
    'agent_advance_penalty_accrued_external',
    -- Landlord Float Pool (20260929160000, 20260929180000, 20260929240000)
    'landlord_pool_reserve_self_support',
    'landlord_pool_reserve_company_managed',
    'landlord_pool_reserve_source',
    'landlord_pool_topup_self_support',
    'landlord_pool_topup_company_managed',
    'landlord_pool_compound_self_support',
    'landlord_pool_compound_company_managed',
    'landlord_pool_deploy_self_support',
    'landlord_pool_deploy_company_managed',
    'landlord_pool_deploy_target',
    'landlord_pool_return_self_support',
    'landlord_pool_return_company_managed',
    'landlord_pool_return_source',
    'landlord_pool_release_self_support',
    'landlord_pool_release_company_managed',
    'landlord_pool_release_target'
  ]::text[];
$function$;
