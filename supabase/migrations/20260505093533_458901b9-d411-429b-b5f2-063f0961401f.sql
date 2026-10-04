
-- =========================================================================
-- 1. Extend the ledger category allowlist with the two reconciliation tags
-- =========================================================================
CREATE OR REPLACE FUNCTION public.validate_ledger_category()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
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
    'debt_recovery',
    -- new reconciliation categories (2026-05-05)
    'historical_balance_reseed','platform_loss_writeoff'
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

-- Also extend the role-blind router so future flows can use these safely.
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
  IF p_direction IN ('credit','cash_in') THEN
    v_sign := 1;
  ELSIF p_direction IN ('debit','cash_out') THEN
    v_sign := -1;
  ELSE
    RAISE EXCEPTION 'UNSUPPORTED_LEDGER_DIRECTION: %', p_direction;
  END IF;

  IF p_category IN (
    'agent_float_deposit','agent_float_assignment','agent_float_topup',
    'agent_float_funding','agent_float_used_for_rent','agent_float_used',
    'agent_float_settlement',
    'agent_landlord_payout','rent_disbursement','rent_float_funding'
  ) THEN
    RETURN QUERY SELECT 'float'::text, v_sign; RETURN;
  END IF;

  IF p_category IN ('agent_advance_credit','salary_advance') AND v_sign = 1 THEN
    RETURN QUERY SELECT 'advance_credit'::text, 1; RETURN;
  END IF;
  IF p_category IN ('agent_advance_repayment','salary_advance_repayment','debt_recovery') AND v_sign = -1 THEN
    RETURN QUERY SELECT 'advance_repayment'::text, -1; RETURN;
  END IF;

  IF p_category IN (
    'wallet_deposit','deposit','wallet_transfer','cfo_direct_credit',
    'agent_commission_earned','agent_commission','agent_bonus',
    'partner_commission','referral_bonus','proxy_investment_commission',
    'agent_investment_commission','salary_payout','roi_payout',
    'roi_wallet_credit','manager_credit','tenant_repayment',
    'partner_funding','supporter_capital','supporter_rent_fund',
    'pool_capital_received','landlord_rent_payment','rent_repayment',
    'credit_access_repayment','rent_principal_collected',
    'access_fee_collected','registration_fee_collected',
    'system_balance_correction','balance_correction','reconciliation',
    'orphan_reversal','correction_reversal','account_merge',
    'rent_obligation_reversal','rent_obligation_reversal_adjustment',
    'pool_rent_deployment_reversal','coo_proxy_investment_reversal',
    'debt_clearance','🔧 Manual Adjustment',
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
    'research_development_expense',
    -- new reconciliation categories
    'historical_balance_reseed','platform_loss_writeoff'
  ) THEN
    RETURN QUERY SELECT 'withdrawable'::text, v_sign; RETURN;
  END IF;

  RAISE EXCEPTION 'UNSUPPORTED_LEDGER_CATEGORY: % (direction=%)', p_category, p_direction;
END;
$function$;

-- =========================================================================
-- 2. Reconciliation log
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.wallet_negative_reconciliation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL,
  user_id uuid NOT NULL,
  deficit_cleared numeric NOT NULL,
  ledger_net_before numeric NOT NULL,
  cached_withdrawable_before numeric,
  reseed_ledger_id uuid,
  writeoff_ledger_id uuid,
  reconciled_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.wallet_negative_reconciliation_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cfo can read reconciliation log" ON public.wallet_negative_reconciliation_log;
CREATE POLICY "cfo can read reconciliation log"
  ON public.wallet_negative_reconciliation_log
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'ceo')
  );

CREATE INDEX IF NOT EXISTS idx_wallet_neg_recon_batch ON public.wallet_negative_reconciliation_log(batch_id);
CREATE INDEX IF NOT EXISTS idx_wallet_neg_recon_user ON public.wallet_negative_reconciliation_log(user_id);

-- =========================================================================
-- 3. Reconciliation function — one-shot wipe of negative ledger balances
--    without touching the cached wallet (skip_bucket_sync = true).
-- =========================================================================
CREATE OR REPLACE FUNCTION public.reconcile_negative_wallets(
  p_dry_run boolean DEFAULT true,
  p_max_users integer DEFAULT 1000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_batch_id uuid := gen_random_uuid();
  v_rec record;
  v_count int := 0;
  v_total numeric := 0;
  v_reseed_id uuid;
  v_writeoff_id uuid;
  v_cached numeric;
BEGIN
  IF NOT (
    public.has_role(v_caller, 'cfo')
    OR public.has_role(v_caller, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'unauthorized: only CFO or super_admin can reconcile';
  END IF;

  -- Authorize ledger writes for this session
  PERFORM set_config('ledger.authorized', 'true', true);
  -- Skip the wallet bucket sync — the cached balance is what users see and we must NOT change it
  PERFORM set_config('ledger.skip_bucket_sync', 'true', true);

  FOR v_rec IN
    WITH net AS (
      SELECT user_id,
             SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END) AS bal
      FROM public.general_ledger
      WHERE ledger_scope='wallet'
        AND user_id IS NOT NULL
        AND classification <> 'admin_correction'
        AND category <> 'system_balance_correction'
      GROUP BY user_id
    )
    SELECT user_id, bal
    FROM net
    WHERE bal < 0
    ORDER BY bal ASC
    LIMIT GREATEST(p_max_users, 1)
  LOOP
    v_count := v_count + 1;
    v_total := v_total + ABS(v_rec.bal);

    IF p_dry_run THEN CONTINUE; END IF;

    SELECT withdrawable_balance INTO v_cached FROM public.wallets WHERE user_id = v_rec.user_id;

    -- (A) Reseed leg: wallet-scope cash_in to bring strict ledger to zero.
    INSERT INTO public.general_ledger (
      transaction_date, amount, direction, category, description,
      reference_id, user_id, source_table, ledger_scope,
      classification, transaction_group_id
    ) VALUES (
      now(), ABS(v_rec.bal), 'cash_in', 'historical_balance_reseed',
      'Negative-wallet reconciliation: reseed of historical credits previously posted as admin_correction',
      v_batch_id::text, v_rec.user_id, 'wallet_negative_reconciliation_log', 'wallet',
      'production', v_batch_id
    ) RETURNING id INTO v_reseed_id;

    -- (B) Platform-scope cash_out: recognize the gap as a platform write-off.
    INSERT INTO public.general_ledger (
      transaction_date, amount, direction, category, description,
      reference_id, user_id, source_table, ledger_scope,
      classification, transaction_group_id
    ) VALUES (
      now(), ABS(v_rec.bal), 'cash_out', 'platform_loss_writeoff',
      'Negative-wallet reconciliation: write-off of historical over-withdrawal',
      v_batch_id::text, NULL, 'wallet_negative_reconciliation_log', 'platform',
      'production', v_batch_id
    ) RETURNING id INTO v_writeoff_id;

    INSERT INTO public.wallet_negative_reconciliation_log (
      batch_id, user_id, deficit_cleared, ledger_net_before,
      cached_withdrawable_before, reseed_ledger_id, writeoff_ledger_id, reconciled_by
    ) VALUES (
      v_batch_id, v_rec.user_id, ABS(v_rec.bal), v_rec.bal,
      v_cached, v_reseed_id, v_writeoff_id, v_caller
    );
  END LOOP;

  RETURN jsonb_build_object(
    'batch_id', v_batch_id,
    'dry_run', p_dry_run,
    'users_processed', v_count,
    'total_deficit_cleared', v_total
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_negative_wallets(boolean, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_negative_wallets(boolean, integer) TO authenticated;

-- =========================================================================
-- 4. Forward-looking guard: never let a wallet ledger go negative again.
--    Triggered BEFORE INSERT on cash_out wallet rows.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.enforce_no_negative_wallet_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_net numeric;
BEGIN
  -- Only inspect outbound, user-attributed, production wallet rows.
  IF NEW.ledger_scope IS DISTINCT FROM 'wallet' THEN RETURN NEW; END IF;
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.direction <> 'cash_out' THEN RETURN NEW; END IF;
  IF COALESCE(NEW.classification,'') = 'admin_correction' THEN RETURN NEW; END IF;
  IF NEW.category = 'system_balance_correction' THEN RETURN NEW; END IF;
  -- Allow the reconciliation pair itself.
  IF NEW.category = 'platform_loss_writeoff' THEN RETURN NEW; END IF;

  SELECT COALESCE(SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END), 0)
    INTO v_net
    FROM public.general_ledger
    WHERE user_id = NEW.user_id
      AND ledger_scope = 'wallet'
      AND classification <> 'admin_correction'
      AND category <> 'system_balance_correction';

  IF v_net - NEW.amount < 0 THEN
    RAISE EXCEPTION 'NEGATIVE_WALLET_BLOCKED: user % cannot debit % (strict ledger balance is %)',
      NEW.user_id, NEW.amount, v_net
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_no_negative_wallet_ledger ON public.general_ledger;
CREATE TRIGGER trg_enforce_no_negative_wallet_ledger
  BEFORE INSERT ON public.general_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_no_negative_wallet_ledger();
