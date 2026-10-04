-- Tenant Self-Payment (Route B) — M1: ledger foundation.
--
-- PURPOSE
-- Register the two NEW ledger categories the corrected tenant self-payment
-- route needs, and map them so that mapped DR/CR lands on the right accounts.
-- This migration posts NOTHING and changes no existing behaviour. It is inert
-- until M3 replaces settle_tenant_rent_from_deposit().
--
-- WHY NEW CATEGORIES AND NOT REUSE
-- The corrected route needs two postings that no existing allowlisted category
-- can express without lying about what happened:
--
--   1. DR L1 on a wallet cash_out  — the tenant's own custody balance is
--      released against their rent receivable.
--      Existing L1 categories were checked and rejected:
--        bucket_reclass_out  -> L1 but debit_when='cash_in'  => cash_out CREDITS
--                               L1. Wrong direction.
--        partner_funding     -> L1, debit_when='cash_out' (direction correct)
--                               but it means partner capital. Reusing it would
--                               file a tenant rent payment as partner funding.
--        supporter_rent_fund -> same objection.
--
--   2. DR L5 on a platform cash_out — settling the Agent Commission Payable
--      that post_instalment_waterfall() accrued.
--        agent_commission_accrued -> L5 but debit_when='cash_in', which is what
--                               the waterfall uses to CREATE the payable
--                               (cash_out => CR L5). Reusing it for settlement
--                               would be indistinguishable from another accrual.
--
-- Mis-filing a money movement under a semantically wrong category is exactly
-- how the current defect population was created. New, purpose-named categories
-- are the correct answer.
--
-- GATES THESE CATEGORIES MUST PASS (all verified against production)
--   * treasury_controls.strict_mode is ENABLED, so trg_validate_ledger_category
--     rejects any category absent from ledger_category_allowlist(). Both are
--     added below.
--   * trg_assert_wallet_routing requires wallet-scope legs to resolve a bucket
--     via wallet_route_for_category(). 'tenant_rent_settlement' is deliberately
--     NOT added to any float list, so it falls through to the default
--     'withdrawable' branch with sign = -1 on cash_out. That is precisely the
--     intent: the tenant's own withdrawable balance decreases. This holds for
--     agent-role users too, because the agent float overrides are an explicit
--     category list that does not include it.
--   * 'agent_commission_settled' is platform-scope, so wallet routing does not
--     apply to it.
--
-- ADDITIVE ONLY. The allowlist is rewritten with exactly its current contents
-- plus the two new entries. Nothing is removed.

-- 1. Allowlist -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT '{"🔧 Manual Adjustment",access_fee_collected,account_merge,advance_repayment,agent_advance_credit,agent_advance_repayment,agent_bonus,agent_commission,agent_commission_accrued,agent_commission_earned,agent_commission_payable,agent_commission_settled,agent_commission_used_for_rent,agent_commission_withdrawal,agent_facilitated_capital_receivable,agent_float_assignment,agent_float_cash_offset,agent_float_deposit,agent_float_funding,agent_float_settlement,agent_float_topup,agent_float_used,agent_float_used_for_rent,agent_investment_commission,agent_landlord_payout,agent_proxy_investment,agent_repayment,angel_pool_investment,balance_correction,bucket_reclass_in,bucket_reclass_out,cash_at_bank_reclass,cash_custody_payable,cash_in_transit_banked,cash_receipt_in_transit,cfo_direct_credit,coo_proxy_investment,coo_proxy_investment_reversal,correction_reversal,credit_access_repayment,debt_clearance,debt_recovery,deposit,equipment_expense,fee_receivable_created,general_admin_expense,historical_balance_reseed,interest_expense,landlord_receivable_collected,landlord_receivable_created,landlord_receivable_obligation,landlord_rent_payment,listing_bonus,listing_bonus_expense,listing_rejection_offset,listing_rejection_penalty,listing_rejection_recovery,manager_credit,manager_debit,marketing_expense,merchant_float_correction_writedown,merchant_oop_reimbursement,orphan_reassignment,orphan_reversal,partner_capital_cash_received,partner_commission,partner_funding,partner_receivable_capital,partner_receivable_collected,partner_receivable_created,partner_reward_accrued,payroll_expense,pending_portfolio_topup,platform_expense,platform_loss_writeoff,pool_capital_received,pool_rent_deployment_reversal,proxy_investment_commission,proxy_partner_withdrawal,reconciliation,referral_bonus,registration_fee_collected,rent_disbursement,rent_float_funding,rent_obligation,rent_obligation_reversal,rent_obligation_reversal_adjustment,rent_payment_for_tenant,rent_payment_received,rent_principal_collected,rent_receivable_created,rent_repayment,research_development_expense,roi_expense,roi_payout,roi_reinvestment,roi_wallet_credit,salary_advance,salary_advance_repayment,salary_payout,share_capital,supporter_capital,supporter_rent_fund,system_balance_correction,tax_expense,tenant_default_charge,tenant_repayment,tenant_rent_settlement,test_funds_cleanup,treasury_allocated,treasury_bank_deposit,treasury_fee_recognised,treasury_net_revenue,wallet_deduction,wallet_deduction_cash_payout_retraction,wallet_deduction_general_adjustment,wallet_deposit,wallet_to_investment,wallet_transfer,wallet_withdrawal}'::text[]
$function$;

-- 2. Account mappings ----------------------------------------------------
-- tenant_rent_settlement: wallet scope, withdrawable bucket.
--   debit_when='cash_out' => the cash_out leg DEBITS L1, releasing the tenant's
--   custody balance. Pairs with platform.tenant_repayment posted cash_in
--   (A3, debit_when='cash_out' => CREDITS A3).
--   Raw control:    cash_out = cash_in.
--   Mapped control: DR L1 = CR A3.
INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when)
VALUES ('wallet', 'tenant_rent_settlement', 'withdrawable', 'L1', 'cash_out')
ON CONFLICT DO NOTHING;

-- agent_commission_settled: platform scope.
--   debit_when='cash_out' => the cash_out leg DEBITS L5, discharging the
--   payable the waterfall accrued. Pairs with wallet.agent_commission_earned
--   posted cash_in, which credits the agent's own L1 custody.
INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when)
VALUES ('platform', 'agent_commission_settled', NULL, 'L5', 'cash_out')
ON CONFLICT DO NOTHING;

-- 3. Assertions ----------------------------------------------------------
DO $$
DECLARE v_n integer;
BEGIN
  IF NOT public.validate_ledger_category('tenant_rent_settlement') THEN
    RAISE EXCEPTION 'tenant_rent_settlement not allowlisted';
  END IF;
  IF NOT public.validate_ledger_category('agent_commission_settled') THEN
    RAISE EXCEPTION 'agent_commission_settled not allowlisted';
  END IF;

  -- The wallet router must send it to withdrawable with a negative sign on
  -- cash_out. If this ever changes, the tenant's money would move to the wrong
  -- bucket, so it is asserted rather than assumed.
  IF (SELECT bucket FROM public.wallet_route_for_category('tenant_rent_settlement','cash_out')) <> 'withdrawable'
     OR (SELECT sign FROM public.wallet_route_for_category('tenant_rent_settlement','cash_out')) <> -1 THEN
    RAISE EXCEPTION 'tenant_rent_settlement does not route to withdrawable/-1';
  END IF;

  SELECT count(*) INTO v_n FROM public.ledger_account_map
   WHERE (ledger_scope,category,account_code,debit_when) IN
         (('wallet','tenant_rent_settlement','L1','cash_out'),
          ('platform','agent_commission_settled','L5','cash_out'));
  IF v_n <> 2 THEN RAISE EXCEPTION 'expected 2 new map rows, found %', v_n; END IF;

  -- Nothing was removed from the allowlist.
  IF array_length(public.ledger_category_allowlist(), 1) < 118 THEN
    RAISE EXCEPTION 'allowlist shrank unexpectedly: %', array_length(public.ledger_category_allowlist(),1);
  END IF;
END $$;
