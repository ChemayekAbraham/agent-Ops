-- Security hardening: take the internal money-moving RPCs off the public API.
-- No accounting change, no balance change, no posting-logic change.
--
-- WHY
-- ---
-- ALTER DEFAULT PRIVILEGES in `public` grants EXECUTE on every new function to
-- PUBLIC, anon and authenticated. Every function below is SECURITY DEFINER,
-- owned by postgres, has no auth.uid()/has_role() gate of its own, and posts to
-- general_ledger (directly or via create_ledger_transaction) or moves wallet /
-- withdrawal / portfolio state. Verified against production on 2026-09-27:
-- all of them were executable by `anon` (pay_partner_self_cycles by
-- `authenticated` only). With the public anon key that ships in the web bundle,
-- anyone on the internet could, for example:
--
--   * create_ledger_transaction(entries, key, skip_balance_check)
--       post a balanced pair "platform cash_out / wallet cash_in" to any user
--       and mint withdrawable balance. The ledger.authorized trigger guard does
--       not help: this function is the thing that sets ledger.authorized.
--   * credit_agent_event_bonus(agent, 'service_centre_setup', _, <new id>)
--       UGX 25,000 to any agent per call, unlimited with fresh source ids.
--   * welile_home_record_collection(sub, amount, 'tenant_wallet')
--       debit any Welile Homes tenant's wallet.
--   * welile_home_run_landlord_payouts / pay_partner_self_cycles /
--     auto_dispatch_withdrawals / restate_*_receivables / merge_paidout_topups
--       run payout or restatement batches on demand, out of schedule.
--
-- WHAT THIS DOES
-- --------------
-- 1. REVOKE EXECUTE FROM PUBLIC, anon, authenticated on the internal functions.
--    service_role and postgres keep EXECUTE.
-- 2. mature_bonus_by_subject and mature_referral_bonuses_for_invitee are
--    revoked from PUBLIC and anon ONLY: they are called by SECURITY INVOKER
--    triggers (trg_mature_on_house_verified_fn, trg_mature_on_lc1_verified_fn,
--    trg_mature_on_rent_request_fn) that fire on writes made by signed-in
--    users, so `authenticated` must keep EXECUTE until those triggers are made
--    SECURITY DEFINER.
-- 3. Four functions have legitimate frontend callers. Each gets a thin
--    SECURITY DEFINER wrapper that checks the caller's role, and the frontend
--    is switched to the wrapper in the same change:
--      staff_create_ledger_transaction      <- src/components/coo/COOPartnersPage.tsx (x3)
--      staff_credit_agent_event_bonus       <- src/components/cfo/ServiceCentrePayoutApproval.tsx
--      staff_welile_home_run_landlord_payouts <- src/components/ops/WelileHomesAdminPanel.tsx
--      agent_welile_home_record_collection  <- src/components/agent/AgentWelileHomesSheet.tsx
--
-- LEGITIMATE CALLERS (verified before writing this) - none of them affected
-- --------------------------------------------------------------------------
--   * Edge functions: every .rpc() call to these names uses a service-role
--     client (checked by scanning supabase/functions for anon/publishable-key
--     clients - none call these).
--   * pg_cron: all 198 jobs run as `postgres`.
--   * Nested calls from other SECURITY DEFINER functions execute as their
--     owner (postgres), which keeps EXECUTE.
--   * The only SECURITY INVOKER callers in `public` are the three triggers in
--     (2) and assert_funding_treasury_recognised, which is itself only reached
--     through the SECURITY DEFINER record_rent_request_repayment_v2.
--
-- scripts/guard-privileged-function-grants.mjs is extended to protect these.
-- Idempotent: REVOKE on an already-revoked privilege is a no-op.

-- ── 1. Internal-only: revoke from PUBLIC, anon, authenticated ─────────────
REVOKE EXECUTE ON FUNCTION public.create_ledger_transaction(jsonb, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.create_ledger_transaction(uuid, jsonb, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.create_ledger_transaction_accrual_only(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.create_ledger_transaction_locked(jsonb, uuid, numeric, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_double_entry(uuid, uuid, numeric, text, text, text, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.apply_wallet_movement(uuid, text, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.apply_wallet_movement(uuid, text, numeric, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.drain_withdrawable_buckets(uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recompute_wallet_buckets(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reconcile_wallet_from_pivot(uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.repair_wallet_cache_for_user(uuid) FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.credit_agent_event_bonus(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.credit_agent_rent_commission(uuid, numeric, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.credit_agent_rent_commission(uuid, numeric, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.credit_recruiter_override(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.credit_recruiter_override(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.credit_proxy_approval(uuid, uuid, numeric, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.credit_proxy_approval(uuid, uuid, numeric, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pay_proxy_commission_queue_item(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.try_credit_qualified_referrals(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.process_monthly_referral_rewards() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.expire_stale_bonus_restrictions() FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.agent_allocate_tenant_payment_internal(uuid, uuid, uuid, numeric, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.post_instalment_waterfall(uuid, numeric, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.post_rent_fee_collection(uuid, numeric, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.post_treasury_fee_cash_transfer(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.settle_tenant_rent_from_deposit(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reverse_phantom_auto_debit_obligation(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recover_merchandise_from_wallets() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.welile_home_record_collection(uuid, numeric, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.welile_home_run_landlord_payouts(date) FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.recognise_funding_treasury(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recognise_landlord_receivable(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recognise_partner_receivable(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.derecognise_partner_receivable(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.restate_agent_receivables(text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.restate_rent_plan_receivables(text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.restate_rent_plan_receivables_tagged(text, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.psm_release_self_funding_line(uuid, text) FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.apply_portfolio_redemption(uuid, text, numeric, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.apply_portfolio_renewal(uuid, uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.merge_paidout_topups() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pay_partner_self_cycles(integer) FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.auto_dispatch_withdrawals(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ensure_merchant_payout_float_debit(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_withdrawal_settlement_state(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reconcile_evidenced_withdrawal_settlements() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_stale_cashout_claims() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.detect_stale_withdrawal_holds() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.detect_bulk_payout_stuck_alerts() FROM PUBLIC, anon, authenticated;

-- ── 2. Reached from SECURITY INVOKER triggers: revoke anon only ───────────
REVOKE EXECUTE ON FUNCTION public.mature_bonus_by_subject(text, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.mature_referral_bonuses_for_invitee(uuid) FROM PUBLIC, anon;
-- Explicit, so revoking PUBLIC can never strip a grant these roles only held
-- through PUBLIC.
GRANT EXECUTE ON FUNCTION public.mature_bonus_by_subject(text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mature_referral_bonuses_for_invitee(uuid) TO authenticated, service_role;

-- Edge functions call every function in (1) with the service-role key. Make
-- that grant explicit for the same reason.
DO $$
DECLARE
  v_fn regprocedure;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.create_ledger_transaction(jsonb, text, boolean)',
    'public.create_ledger_transaction(uuid, jsonb, text, boolean)',
    'public.create_ledger_transaction_accrual_only(jsonb)',
    'public.create_ledger_transaction_locked(jsonb, uuid, numeric, text, boolean)',
    'public.record_double_entry(uuid, uuid, numeric, text, text, text, uuid, text, text, text, text)',
    'public.apply_wallet_movement(uuid, text, numeric, text)',
    'public.apply_wallet_movement(uuid, text, numeric, text, text)',
    'public.drain_withdrawable_buckets(uuid, numeric)',
    'public.recompute_wallet_buckets(uuid)',
    'public.reconcile_wallet_from_pivot(uuid, numeric)',
    'public.repair_wallet_cache_for_user(uuid)',
    'public.credit_agent_event_bonus(uuid, text, uuid, text)',
    'public.credit_agent_rent_commission(uuid, numeric, text, uuid)',
    'public.credit_agent_rent_commission(uuid, numeric, uuid, text)',
    'public.credit_recruiter_override(uuid, text, uuid)',
    'public.credit_recruiter_override(uuid, text, text, text, text)',
    'public.credit_proxy_approval(uuid, uuid, numeric, text, text)',
    'public.credit_proxy_approval(uuid, uuid, numeric, text, text, uuid, text)',
    'public.pay_proxy_commission_queue_item(uuid)',
    'public.try_credit_qualified_referrals(uuid)',
    'public.process_monthly_referral_rewards()',
    'public.expire_stale_bonus_restrictions()',
    'public.agent_allocate_tenant_payment_internal(uuid, uuid, uuid, numeric, text, uuid)',
    'public.post_instalment_waterfall(uuid, numeric, text, uuid, text)',
    'public.post_rent_fee_collection(uuid, numeric, text, uuid)',
    'public.post_treasury_fee_cash_transfer(uuid)',
    'public.settle_tenant_rent_from_deposit(uuid)',
    'public.reverse_phantom_auto_debit_obligation(uuid)',
    'public.recover_merchandise_from_wallets()',
    'public.welile_home_record_collection(uuid, numeric, text, text)',
    'public.welile_home_run_landlord_payouts(date)',
    'public.recognise_funding_treasury(uuid)',
    'public.recognise_landlord_receivable(uuid)',
    'public.recognise_partner_receivable(uuid)',
    'public.derecognise_partner_receivable(uuid, text)',
    'public.restate_agent_receivables(text, boolean)',
    'public.restate_rent_plan_receivables(text, boolean)',
    'public.restate_rent_plan_receivables_tagged(text, text, boolean)',
    'public.psm_release_self_funding_line(uuid, text)',
    'public.apply_portfolio_redemption(uuid, text, numeric, text, uuid, boolean)',
    'public.apply_portfolio_renewal(uuid, uuid, text, text, boolean)',
    'public.merge_paidout_topups()',
    'public.pay_partner_self_cycles(integer)',
    'public.auto_dispatch_withdrawals(integer)',
    'public.ensure_merchant_payout_float_debit(uuid)',
    'public.record_withdrawal_settlement_state(uuid)',
    'public.reconcile_evidenced_withdrawal_settlements()',
    'public.release_stale_cashout_claims()',
    'public.detect_stale_withdrawal_holds()',
    'public.detect_bulk_payout_stuck_alerts()'
  ]::regprocedure[]
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END;
$$;

-- ── 3. Role-gated wrappers for the four frontend call sites ───────────────

-- COO partner directory: ROI compounding / Returns-to-wallet postings.
CREATE OR REPLACE FUNCTION public.staff_create_ledger_transaction(
  entries jsonb,
  idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND enabled = true
      AND role::text = ANY (ARRAY['coo','ceo','cfo','cto','manager','super_admin','partner_ops'])
  ) THEN
    RAISE EXCEPTION 'Not authorised to post ledger entries' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The balance check is never skippable from the client.
  RETURN public.create_ledger_transaction(
    entries            => entries,
    idempotency_key    => idempotency_key,
    skip_balance_check => false
  );
END;
$$;

-- CFO service-centre setup payout.
CREATE OR REPLACE FUNCTION public.staff_credit_agent_event_bonus(
  p_agent_id uuid,
  p_event_type text,
  p_tenant_id uuid DEFAULT NULL,
  p_source_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND enabled = true
      AND role::text = ANY (ARRAY['cfo','coo','ceo','cto','super_admin','manager','financial_ops','agent_ops'])
  ) THEN
    RAISE EXCEPTION 'Not authorised to credit agent bonuses' USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN public.credit_agent_event_bonus(p_agent_id, p_event_type, p_tenant_id, p_source_id);
END;
$$;

-- Tenant Ops: manual run of the Welile Homes landlord payout batch.
CREATE OR REPLACE FUNCTION public.staff_welile_home_run_landlord_payouts(
  p_as_of date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND enabled = true
      AND role::text = ANY (ARRAY['tenant_ops','landlord_ops','operations','coo','ceo','cfo','cto','super_admin','manager'])
  ) THEN
    RAISE EXCEPTION 'Not authorised to run landlord payouts' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Never pay out dues dated in the future.
  RETURN public.welile_home_run_landlord_payouts(LEAST(COALESCE(p_as_of, CURRENT_DATE), CURRENT_DATE));
END;
$$;

-- Agent records a Welile Homes collection: only the subscription's own agent,
-- or Ops staff, may post against it.
CREATE OR REPLACE FUNCTION public.agent_welile_home_record_collection(
  p_subscription_id uuid,
  p_amount numeric,
  p_source text DEFAULT 'agent_allocation',
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM public.welile_homes_subscriptions
       WHERE id = p_subscription_id AND agent_id = v_uid
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.user_roles
       WHERE user_id = v_uid AND enabled = true
         AND role::text = ANY (ARRAY['tenant_ops','agent_ops','operations','coo','ceo','cfo','cto','super_admin','manager'])
     )
  THEN
    RAISE EXCEPTION 'Not authorised to record collections for this subscription' USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN public.welile_home_record_collection(p_subscription_id, p_amount, p_source, p_notes);
END;
$$;

-- Wrappers are for signed-in users only; the role check does the rest.
REVOKE EXECUTE ON FUNCTION public.staff_create_ledger_transaction(jsonb, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.staff_credit_agent_event_bonus(uuid, text, uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.staff_welile_home_run_landlord_payouts(date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.agent_welile_home_record_collection(uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_create_ledger_transaction(jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_credit_agent_event_bonus(uuid, text, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_welile_home_run_landlord_payouts(date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agent_welile_home_record_collection(uuid, numeric, text, text) TO authenticated, service_role;
