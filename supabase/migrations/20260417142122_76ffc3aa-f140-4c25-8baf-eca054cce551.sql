
-- ============================================================================
-- WALLET RECOVERY MIGRATION (2026-04-17)
-- Phases: 0 Freeze · 1 Backup · 2 Hard-fail Router · 3 Recompute · 6 Guard
-- ============================================================================

-- ----------------------------------------------------------------------------
-- PHASE 0: FREEZE
-- ----------------------------------------------------------------------------
ALTER TABLE public.general_ledger DISABLE TRIGGER general_ledger_route_buckets;

INSERT INTO public.treasury_controls (control_key, enabled, strict_mode, updated_at)
VALUES ('withdrawals_paused', true, false, now()),
       ('credits_paused',     true, false, now())
ON CONFLICT (control_key) DO UPDATE SET enabled = true, updated_at = now();

-- ----------------------------------------------------------------------------
-- PHASE 1: BACKUP
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.wallet_backup_2026_04_17;
CREATE TABLE public.wallet_backup_2026_04_17 AS
SELECT *, now() AS snapshot_at FROM public.wallets;

ALTER TABLE public.wallet_backup_2026_04_17 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Super admin only" ON public.wallet_backup_2026_04_17
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'));

-- ----------------------------------------------------------------------------
-- PHASE 2: HARD-FAIL ROUTER (defensive — no more silent skips)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wallet_route_for_category(p_category text, p_direction text)
RETURNS TABLE(bucket text, sign integer)
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
BEGIN
  -- ===== CREDITS (cash_in) =====
  IF p_direction IN ('credit', 'cash_in') THEN
    -- Withdrawable bucket
    IF p_category IN (
      'wallet_deposit', 'deposit', 'wallet_transfer', 'cfo_direct_credit',
      'agent_commission_earned', 'agent_commission', 'agent_bonus',
      'partner_commission', 'referral_bonus', 'proxy_investment_commission',
      'agent_investment_commission', 'salary_payout', 'roi_payout',
      'roi_wallet_credit', 'manager_credit', 'tenant_repayment',
      'partner_funding', 'supporter_capital', 'supporter_rent_fund',
      'pool_capital_received', 'landlord_rent_payment', 'rent_repayment',
      'credit_access_repayment', 'rent_principal_collected',
      'access_fee_collected', 'registration_fee_collected'
    ) THEN
      RETURN QUERY SELECT 'withdrawable'::text, 1; RETURN;
    END IF;

    -- Float bucket
    IF p_category IN (
      'agent_float_deposit', 'agent_float_assignment', 'agent_float_topup',
      'agent_float_funding', 'rent_float_funding'
    ) THEN
      RETURN QUERY SELECT 'float'::text, 1; RETURN;
    END IF;

    -- Advance bucket (creates obligation)
    IF p_category IN ('agent_advance_credit', 'salary_advance') THEN
      RETURN QUERY SELECT 'advance_credit'::text, 1; RETURN;
    END IF;

    -- Reversals / corrections that ADD money back to withdrawable
    IF p_category IN (
      'system_balance_correction', 'balance_correction', 'reconciliation',
      'orphan_reversal', 'correction_reversal', 'account_merge',
      'rent_obligation_reversal', 'rent_obligation_reversal_adjustment',
      'pool_rent_deployment_reversal', 'coo_proxy_investment_reversal',
      'debt_clearance', '🔧 Manual Adjustment'
    ) THEN
      RETURN QUERY SELECT 'withdrawable'::text, 1; RETURN;
    END IF;

    -- Investment/proxy outflows recorded as cash_in to a counterparty wallet
    IF p_category IN (
      'agent_proxy_investment', 'coo_proxy_investment',
      'angel_pool_investment', 'wallet_to_investment',
      'pending_portfolio_topup', 'roi_reinvestment', 'roi_expense',
      'rent_payment_for_tenant', 'rent_obligation', 'rent_disbursement',
      'agent_repayment', 'advance_repayment', 'tenant_default_charge',
      'test_funds_cleanup', 'proxy_partner_withdrawal',
      'marketing_expense', 'platform_expense', 'general_admin_expense',
      'research_development_expense', 'wallet_deduction',
      'wallet_deduction_general_adjustment',
      'wallet_deduction_cash_payout_retraction', 'manager_debit'
    ) THEN
      -- These are platform/expense flows — DO NOT credit user wallet on cash_in side
      RETURN QUERY SELECT 'none'::text, 0; RETURN;
    END IF;

    -- HARD FAIL — kills the silent-skip class of bug forever
    RAISE EXCEPTION 'UNSUPPORTED_LEDGER_CATEGORY (credit): %', p_category;
  END IF;

  -- ===== DEBITS (cash_out) =====
  IF p_direction IN ('debit', 'cash_out') THEN
    -- Withdrawable bucket
    IF p_category IN (
      'wallet_withdrawal', 'wallet_transfer', 'wallet_deduction',
      'wallet_deduction_general_adjustment',
      'wallet_deduction_cash_payout_retraction',
      'agent_commission_withdrawal', 'agent_commission_used_for_rent',
      'rent_payment_for_tenant', 'rent_obligation', 'tenant_default_charge',
      'agent_repayment', 'advance_repayment', 'credit_access_repayment',
      'manager_debit', 'agent_proxy_investment', 'coo_proxy_investment',
      'angel_pool_investment', 'wallet_to_investment',
      'pending_portfolio_topup', 'proxy_partner_withdrawal',
      'test_funds_cleanup'
    ) THEN
      RETURN QUERY SELECT 'withdrawable'::text, -1; RETURN;
    END IF;

    -- Float bucket
    IF p_category IN (
      'agent_float_used_for_rent', 'rent_disbursement',
      'agent_float_used', 'agent_landlord_payout', 'rent_float_funding'
    ) THEN
      RETURN QUERY SELECT 'float'::text, -1; RETURN;
    END IF;

    -- Advance repayment
    IF p_category IN ('agent_advance_repayment', 'salary_advance_repayment', 'debt_recovery') THEN
      RETURN QUERY SELECT 'advance_repayment'::text, -1; RETURN;
    END IF;

    -- Platform-side debits that don't touch any user wallet bucket
    IF p_category IN (
      'wallet_deposit', 'deposit', 'partner_funding', 'supporter_capital',
      'supporter_rent_fund', 'pool_capital_received', 'roi_payout',
      'roi_wallet_credit', 'roi_expense', 'roi_reinvestment',
      'agent_commission_earned', 'agent_commission', 'agent_bonus',
      'partner_commission', 'referral_bonus', 'proxy_investment_commission',
      'agent_investment_commission', 'salary_payout',
      'access_fee_collected', 'registration_fee_collected',
      'rent_principal_collected', 'rent_repayment',
      'system_balance_correction', 'balance_correction', 'reconciliation',
      'orphan_reversal', 'correction_reversal', 'account_merge',
      'rent_obligation_reversal', 'rent_obligation_reversal_adjustment',
      'pool_rent_deployment_reversal', 'coo_proxy_investment_reversal',
      'debt_clearance', '🔧 Manual Adjustment',
      'agent_float_deposit', 'agent_float_assignment', 'agent_float_topup',
      'agent_float_funding', 'agent_advance_credit', 'salary_advance',
      'manager_credit', 'tenant_repayment', 'landlord_rent_payment',
      'marketing_expense', 'platform_expense', 'general_admin_expense',
      'research_development_expense'
    ) THEN
      RETURN QUERY SELECT 'none'::text, 0; RETURN;
    END IF;

    -- HARD FAIL
    RAISE EXCEPTION 'UNSUPPORTED_LEDGER_CATEGORY (debit): %', p_category;
  END IF;

  RAISE EXCEPTION 'UNSUPPORTED_LEDGER_DIRECTION: %', p_direction;
END;
$function$;

-- ----------------------------------------------------------------------------
-- PHASE 3: FULL RECOMPUTE (re-enable trigger first so any new writes route correctly)
-- ----------------------------------------------------------------------------
ALTER TABLE public.general_ledger ENABLE TRIGGER general_ledger_route_buckets;

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

-- ----------------------------------------------------------------------------
-- PHASE 6: LONG-TERM INTEGRITY GUARD (audit view)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.wallet_ledger_integrity_audit AS
WITH ledger_net AS (
  SELECT user_id,
    SUM(CASE WHEN direction IN ('credit','cash_in') THEN amount ELSE -amount END) AS net
  FROM public.general_ledger
  WHERE ledger_scope = 'wallet' AND user_id IS NOT NULL
  GROUP BY user_id
)
SELECT w.user_id,
       w.withdrawable_balance,
       w.float_balance,
       w.advance_balance,
       (w.withdrawable_balance + w.float_balance - w.advance_balance) AS wallet_net,
       COALESCE(l.net, 0) AS ledger_net,
       (w.withdrawable_balance + w.float_balance - w.advance_balance) - COALESCE(l.net, 0) AS drift
FROM public.wallets w
LEFT JOIN ledger_net l ON l.user_id = w.user_id
WHERE ABS((w.withdrawable_balance + w.float_balance - w.advance_balance) - COALESCE(l.net, 0)) > 1;

ALTER VIEW public.wallet_ledger_integrity_audit OWNER TO postgres;

-- Audit log entry
INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
VALUES (
  NULL,
  'wallet_recovery_migration',
  'wallets',
  gen_random_uuid(),
  jsonb_build_object(
    'phase', 'completed',
    'snapshot_table', 'wallet_backup_2026_04_17',
    'router_rewritten', true,
    'recompute_run', true,
    'frozen_keys', ARRAY['withdrawals_paused','credits_paused']
  )
);
