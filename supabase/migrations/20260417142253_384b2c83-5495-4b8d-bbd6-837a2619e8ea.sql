
-- ============================================================================
-- ROUTER FIX: trust direction, categorize bucket only
-- ============================================================================
CREATE OR REPLACE FUNCTION public.wallet_route_for_category(p_category text, p_direction text)
RETURNS TABLE(bucket text, sign integer)
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_sign int;
  v_bucket text;
BEGIN
  -- Direction is the source of truth for sign
  IF p_direction IN ('credit','cash_in') THEN
    v_sign := 1;
  ELSIF p_direction IN ('debit','cash_out') THEN
    v_sign := -1;
  ELSE
    RAISE EXCEPTION 'UNSUPPORTED_LEDGER_DIRECTION: %', p_direction;
  END IF;

  -- Float-bucket categories
  IF p_category IN (
    'agent_float_deposit','agent_float_assignment','agent_float_topup',
    'agent_float_funding','agent_float_used_for_rent','agent_float_used',
    'agent_landlord_payout','rent_disbursement','rent_float_funding'
  ) THEN
    v_bucket := 'float';
    RETURN QUERY SELECT v_bucket, v_sign;
    RETURN;
  END IF;

  -- Advance-bucket categories
  IF p_category IN ('agent_advance_credit','salary_advance') AND v_sign = 1 THEN
    RETURN QUERY SELECT 'advance_credit'::text, 1; RETURN;
  END IF;
  IF p_category IN ('agent_advance_repayment','salary_advance_repayment','debt_recovery') AND v_sign = -1 THEN
    RETURN QUERY SELECT 'advance_repayment'::text, -1; RETURN;
  END IF;

  -- Known wallet-impact categories → withdrawable bucket, signed by direction
  IF p_category IN (
    -- Deposits / credits
    'wallet_deposit','deposit','wallet_transfer','cfo_direct_credit',
    'agent_commission_earned','agent_commission','agent_bonus',
    'partner_commission','referral_bonus','proxy_investment_commission',
    'agent_investment_commission','salary_payout','roi_payout',
    'roi_wallet_credit','manager_credit','tenant_repayment',
    'partner_funding','supporter_capital','supporter_rent_fund',
    'pool_capital_received','landlord_rent_payment','rent_repayment',
    'credit_access_repayment','rent_principal_collected',
    'access_fee_collected','registration_fee_collected',
    -- Reversals / corrections
    'system_balance_correction','balance_correction','reconciliation',
    'orphan_reversal','correction_reversal','account_merge',
    'rent_obligation_reversal','rent_obligation_reversal_adjustment',
    'pool_rent_deployment_reversal','coo_proxy_investment_reversal',
    'debt_clearance','🔧 Manual Adjustment',
    -- Withdrawals / outflows
    'wallet_withdrawal','wallet_deduction',
    'wallet_deduction_general_adjustment',
    'wallet_deduction_cash_payout_retraction',
    'agent_commission_withdrawal','agent_commission_used_for_rent',
    'rent_payment_for_tenant','rent_obligation','tenant_default_charge',
    'agent_repayment','advance_repayment','manager_debit',
    'agent_proxy_investment','coo_proxy_investment',
    'angel_pool_investment','wallet_to_investment',
    'pending_portfolio_topup','proxy_partner_withdrawal',
    'test_funds_cleanup','roi_expense','roi_reinvestment',
    'marketing_expense','platform_expense','general_admin_expense',
    'research_development_expense'
  ) THEN
    RETURN QUERY SELECT 'withdrawable'::text, v_sign;
    RETURN;
  END IF;

  -- HARD FAIL — unknown category
  RAISE EXCEPTION 'UNSUPPORTED_LEDGER_CATEGORY: % (direction=%)', p_category, p_direction;
END;
$function$;

-- Re-run full recompute with corrected router
DO $$
DECLARE r record;
BEGIN
  PERFORM set_config('wallet.sync_authorized', 'true', true);
  FOR r IN SELECT user_id FROM public.wallets LOOP
    BEGIN
      PERFORM public.recompute_wallet_buckets(r.user_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Recompute failed for user %: %', r.user_id, SQLERRM;
    END;
  END LOOP;
END $$;
