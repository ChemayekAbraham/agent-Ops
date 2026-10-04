-- Permanent ledger-category alignment for agent tenant float allocation
-- Root cause: category guards had duplicated allowlists, so one validator could be fixed
-- while another still rejected the same legitimate category in strict mode.

CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
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
    'agent_landlord_payout','🔧 Manual Adjustment'
  ];
$$;

CREATE OR REPLACE FUNCTION public.validate_ledger_category(p_category text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(p_category = ANY(public.ledger_category_allowlist()), false);
$$;

CREATE OR REPLACE FUNCTION public.validate_ledger_category()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  is_strict boolean;
BEGIN
  SELECT COALESCE((
    SELECT enabled
    FROM public.treasury_controls
    WHERE control_key = 'strict_mode'
    LIMIT 1
  ), false)
  INTO is_strict;

  IF is_strict AND NOT public.validate_ledger_category(NEW.category) THEN
    RAISE EXCEPTION 'Category "%" is not in the locked allowlist', NEW.category;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.wallet_route_for_category(p_category text, p_direction text)
RETURNS TABLE(bucket text, sign integer)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_sign int;
BEGIN
  IF p_direction IN ('credit','cash_in') THEN
    v_sign := 1;
  ELSIF p_direction IN ('debit','cash_out') THEN
    v_sign := -1;
  ELSE
    RAISE EXCEPTION 'UNSUPPORTED_LEDGER_DIRECTION: %', p_direction;
  END IF;

  IF NOT public.validate_ledger_category(p_category) THEN
    RAISE EXCEPTION 'UNSUPPORTED_LEDGER_CATEGORY: % (direction=%)', p_category, p_direction;
  END IF;

  IF p_category IN (
    'agent_float_deposit','agent_float_assignment','agent_float_topup',
    'agent_float_funding','agent_float_used_for_rent','agent_float_used',
    'agent_float_settlement','agent_landlord_payout','rent_disbursement','rent_float_funding'
  ) THEN
    RETURN QUERY SELECT 'float'::text, v_sign;
    RETURN;
  END IF;

  IF p_category IN ('agent_advance_credit','salary_advance') AND v_sign = 1 THEN
    RETURN QUERY SELECT 'advance_credit'::text, 1;
    RETURN;
  END IF;

  IF p_category IN ('agent_advance_repayment','salary_advance_repayment','debt_recovery') AND v_sign = -1 THEN
    RETURN QUERY SELECT 'advance_repayment'::text, -1;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'withdrawable'::text, v_sign;
END;
$$;

DO $$
BEGIN
  IF NOT public.validate_ledger_category('rent_payment_for_tenant') THEN
    RAISE EXCEPTION 'Migration failed: rent_payment_for_tenant still not allowlisted';
  END IF;
  IF NOT public.validate_ledger_category('rent_payment_received') THEN
    RAISE EXCEPTION 'Migration failed: rent_payment_received still not allowlisted';
  END IF;
  IF NOT public.validate_ledger_category('agent_commission_earned') THEN
    RAISE EXCEPTION 'Migration failed: agent_commission_earned still not allowlisted';
  END IF;
  IF NOT public.validate_ledger_category('agent_commission_payable') THEN
    RAISE EXCEPTION 'Migration failed: agent_commission_payable still not allowlisted';
  END IF;
END;
$$;