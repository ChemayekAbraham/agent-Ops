-- CFO: settle a tenant's Rent Plan shortfall that the responsible agent owes,
-- funded by a top-up on that agent's Agent Advance — ONE atomic step.
--
-- NOT YET APPLIED.
--
-- WHY
-- ---
-- Case (2026-09-29): Magawa Joan (0742508052), plan 68b2e167-..., UGX 100,000
-- outstanding. She paid her agent (Maasa Mubakal) by hand; the agent never
-- paid all of it in. The CFO ruled the agent is liable for the UGX 100,000 and
-- that it be charged to his advance, after which the tenant's plan is settled
-- and she can be moved to another agent for new rent.
--
-- Doing this as two steps (top-up in the app, then a collection) leaves a
-- window where the agent holds spendable advance money and the plan is still
-- open, and it has no single audit record. This RPC does both in one
-- transaction.
--
-- WHAT IT DOES (all in one transaction; any failure rolls all of it back)
-- ----------------------------------------------------------------------
--   1. apply_advance_topup(p_override_eligibility := true) — UNMODIFIED.
--        wallet  agent_advance_credit  cash_in   (agent wallet, spendable)
--        platform agent_advance_disbursement     (DR A10 / CR L1)
--        access fee: platform A11 / R2, full fee recognised at top-up
--        agent_advance_topups row, advance principal/outstanding/cycle raised
--   2. Group A — tenant custody settlement (same shape as Route B,
--      20260908181000, but the money source is the AGENT's wallet):
--        DR L1  wallet.tenant_rent_settlement (cash_out, withdrawable)  amt
--        CR A3  platform.tenant_repayment     (cash_in)                 amt
--   3. agent_collections row, channel 'agent_liability_settlement',
--      performance_weight 0, float untouched.
--   4. record_rent_request_repayment_v2() — the authoritative repayment path
--      (amount_repaid, repayments row, waterfall for in-scope plans; a
--      no-waterfall no-op for legacy plans, exactly as Route B).
--   5. audit_logs + system_events.
--
-- WHAT IT DELIBERATELY DOES NOT DO
-- --------------------------------
--   * NO commission to the agent or a recruiter on this settlement. It is the
--     agent paying his own shortfall, not a collection he earned on.
--   * NO agent float touched, NO agent_tid_backed_float movement. The
--     TID-backed float rule (20260921100000) governs float-funded collections
--     and is not weakened: the money here is an advance the company records
--     as a receivable from the agent (A10), not float.
--   * apply_advance_topup, create_ledger_transaction, the mapping and the
--     category allowlist are NOT modified. tenant_rent_settlement and
--     tenant_repayment were already mapped and allowlisted (20260908180000).
--
-- NET ACCOUNTING EFFECT of UGX 100,000 at a 30-day extension (fee 33,000):
--   A10 +100,000 (agent owes the company more)   A11/R2 +33,000 fee
--   A3  -100,000 (tenant plan receivable cleared)
--   L1  net 0    (100,000 in, 100,000 out of the agent's wallet)
--   No cash, bank or mobile money moves.
--
-- GUARDS
-- ------
--   * Caller must be CFO, manager or super_admin, and signed in
--     (auth.uid() is not null). Service-role calls are refused.
--   * Reason >= 10 characters (stored in the top-up row and the audit log).
--   * The advance must belong to the plan's agent, so the wrong agent's
--     advance cannot be charged.
--   * Plan must be open and the amount must not exceed its outstanding.
--   * One-shot per plan: a second settlement for the same plan is refused
--     (audit_logs action 'agent_shortfall_settled_via_advance').
--   * Idempotency key on the ledger group derives from the plan + top-up id.

CREATE OR REPLACE FUNCTION public.cfo_settle_tenant_shortfall_via_advance_topup(
  p_advance_id     uuid,
  p_rent_request_id uuid,
  p_amount         numeric,
  p_extend_days    integer,
  p_reason         text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid          uuid := auth.uid();
  v_reason       text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_adv_agent    uuid;
  v_plan         record;
  v_outstanding  numeric;
  v_topup        jsonb;
  v_topup_id     uuid;
  v_avail        numeric;
  v_float        numeric;
  v_tracking     text := 'AGL-' || substr(gen_random_uuid()::text, 1, 8);
  v_group_a      uuid;
  v_collection_id uuid;
  v_orch         jsonb;
  v_new_status   text;
BEGIN
  IF v_uid IS NULL OR NOT (
       public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'manager')
       OR public.has_role(v_uid, 'super_admin')
     ) THEN
    RAISE EXCEPTION 'Only the CFO, a manager or a super admin can settle a tenant shortfall from an agent advance.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_reason IS NULL OR length(v_reason) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required.';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than zero.';
  END IF;

  SELECT rr.id, rr.tenant_id, rr.agent_id, rr.status, rr.landlord_id,
         COALESCE(rr.total_repayment, 0) AS total_repayment,
         COALESCE(rr.amount_repaid, 0)   AS amount_repaid
    INTO v_plan
    FROM public.rent_requests rr
   WHERE rr.id = p_rent_request_id
     FOR UPDATE;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'Rent plan not found.';
  END IF;
  IF v_plan.status NOT IN ('funded', 'disbursed', 'approved', 'repaying') THEN
    RAISE EXCEPTION 'Only an open Rent Plan can be settled (current status: %).', v_plan.status;
  END IF;

  SELECT agent_id INTO v_adv_agent FROM public.agent_advances WHERE id = p_advance_id;
  IF v_adv_agent IS NULL THEN
    RAISE EXCEPTION 'Advance not found.';
  END IF;
  IF v_plan.agent_id IS DISTINCT FROM v_adv_agent THEN
    RAISE EXCEPTION 'That advance belongs to a different agent than the one responsible for this Rent Plan.';
  END IF;

  v_outstanding := GREATEST(0, v_plan.total_repayment - v_plan.amount_repaid);
  IF p_amount > v_outstanding THEN
    RAISE EXCEPTION 'Amount exceeds the plan''s outstanding balance (UGX %).', v_outstanding;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.audit_logs
     WHERE action_type = 'agent_shortfall_settled_via_advance'
       AND table_name = 'rent_requests'
       AND record_id = p_rent_request_id::text
  ) THEN
    RAISE EXCEPTION 'A shortfall settlement has already been applied to this Rent Plan.';
  END IF;

  -- 1. Top-up (unmodified RPC; validates status, principal cap, min amount).
  v_topup := public.apply_advance_topup(
    p_advance_id, p_amount, p_extend_days, NULL, v_reason, true);
  v_topup_id := (v_topup ->> 'topup_id')::uuid;

  -- The credit lands in the agent's wallet in this same transaction; confirm
  -- it is there so the settlement debit cannot trip the solvency gate.
  v_avail := COALESCE((public.get_user_wallet_view(v_adv_agent) ->> 'withdrawable')::numeric, 0);
  IF v_avail < p_amount THEN
    RAISE EXCEPTION 'Settlement refused: agent wallet shows % after the top-up, less than the % to settle. Nothing was changed.',
      v_avail, p_amount USING ERRCODE = '55000';
  END IF;

  -- 2. Group A: DR L1 (agent wallet) / CR A3 (tenant receivable).
  v_group_a := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_adv_agent, 'amount', p_amount, 'direction', 'cash_out',
        'category', 'tenant_rent_settlement', 'ledger_scope', 'wallet',
        'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
        'classification', 'production',
        'description', 'Agent liability: tenant shortfall settled from advance top-up',
        'linked_party', v_plan.landlord_id,
        'source_table', 'agent_collections', 'source_id', p_rent_request_id,
        'reference_id', v_tracking),
      jsonb_build_object(
        'amount', p_amount, 'direction', 'cash_in',
        'category', 'tenant_repayment', 'ledger_scope', 'platform',
        'classification', 'production',
        'description', 'Agent liability settlement reduces tenant rent receivable',
        'linked_party', v_plan.landlord_id,
        'source_table', 'agent_collections', 'source_id', p_rent_request_id,
        'reference_id', v_tracking)
    ),
    format('agent_shortfall_settle:%s:%s', p_rent_request_id, v_topup_id));

  -- 3. Collection row (written before the repayment, as Route B does).
  --    Float is untouched: float_before = float_after = the current float
  --    (the columns are NOT NULL). Weight 0 so it never counts toward the
  --    agent's collection performance.
  v_float := GREATEST(0, COALESCE((public.get_user_wallet_view(v_adv_agent) ->> 'float_balance')::numeric, 0));
  INSERT INTO public.agent_collections (
    agent_id, tenant_id, rent_request_id, amount, payment_method,
    float_before, float_after, tracking_id, notes,
    collection_channel, initiated_by, performance_weight,
    expected_amount, shortfall_amount, is_partial
  ) VALUES (
    v_adv_agent, v_plan.tenant_id, p_rent_request_id, p_amount,
    'in_app_wallet'::collection_payment_method,
    v_float, v_float, v_tracking,
    'Agent liability settlement from advance top-up (CFO ruling): ' || v_reason,
    'agent_liability_settlement', v_uid, 0,
    NULL, 0, false
  )
  RETURNING id INTO v_collection_id;

  -- 4. Authoritative repayment path.
  v_orch := public.record_rent_request_repayment_v2(
    p_tenant_id            => v_plan.tenant_id,
    p_amount               => p_amount,
    p_source_table         => 'agent_collections',
    p_source_id            => v_collection_id,
    p_transaction_group_id => v_group_a,
    p_rent_request_id      => p_rent_request_id
  );

  UPDATE public.rent_requests
     SET last_payment_amount = p_amount,
         updated_at = now()
   WHERE id = p_rent_request_id
  RETURNING status INTO v_new_status;

  -- 5. Audit.
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_uid, 'agent_shortfall_settled_via_advance', 'rent_requests', p_rent_request_id::text, v_reason,
    jsonb_build_object(
      'agent_id', v_adv_agent, 'tenant_id', v_plan.tenant_id, 'advance_id', p_advance_id,
      'topup_id', v_topup_id, 'amount', p_amount, 'extend_days', p_extend_days,
      'access_fee_added', v_topup ->> 'access_fee_added',
      'collection_id', v_collection_id, 'tracking_id', v_tracking,
      'settlement_group_id', v_group_a, 'topup_group_id', v_topup ->> 'transaction_group_id',
      'outstanding_before', v_outstanding,
      'outstanding_after', GREATEST(0, v_outstanding - p_amount),
      'orchestration', v_orch));

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES ('agent_shortfall_settled', v_adv_agent, 'rent_requests', p_rent_request_id,
    jsonb_build_object('advance_id', p_advance_id, 'topup_id', v_topup_id, 'amount', p_amount,
                       'collection_id', v_collection_id, 'actor_id', v_uid,
                       'description', 'Tenant shortfall settled from agent advance top-up'));

  RETURN jsonb_build_object(
    'success', true,
    'rent_request_id', p_rent_request_id,
    'agent_id', v_adv_agent,
    'advance_id', p_advance_id,
    'topup', v_topup,
    'collection_id', v_collection_id,
    'tracking_id', v_tracking,
    'settlement_group_id', v_group_a,
    'amount', p_amount,
    'outstanding_before', v_outstanding,
    'outstanding_after', GREATEST(0, v_outstanding - p_amount),
    'plan_status', v_new_status
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cfo_settle_tenant_shortfall_via_advance_topup(uuid, uuid, numeric, integer, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.cfo_settle_tenant_shortfall_via_advance_topup(uuid, uuid, numeric, integer, text) TO authenticated;

COMMENT ON FUNCTION public.cfo_settle_tenant_shortfall_via_advance_topup(uuid, uuid, numeric, integer, text) IS
  'CFO-only. Tops up the responsible agent''s advance, credits his wallet, and settles the tenant''s Rent Plan shortfall from it in one transaction. No commission, no float, no TID-backed pool movement. One settlement per plan. See docs/HANDOVER/152.';
