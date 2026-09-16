-- Restore a real float cap on agent rent collection and lift the emergency
-- freeze from 20260916100000_freeze_agent_allocate_tenant_payment_float_gap.sql.
--
-- BACKGROUND
-- 20260916100000 froze agent_allocate_tenant_payment(_internal) platform-wide
-- because the 2026-09-15 float redesign made agent float a non-consuming
-- eligibility gate (float_balance >= amount, never decremented), so a flat
-- float balance could back unlimited same-day collections. Confirmed live:
-- agent e05d2e42-3fa4-4fac-beb3-98328163aad9 collected UGX 60,059,171 over 3
-- days against a constant UGX 300,000 float. Separately, the SAME
-- rent_request could take an identical-amount collection every 10-90 seconds
-- for over an hour before the freeze (e.g. rent_request
-- 294797c8-0c1a-4a31-ac82-00d8560173ee, 20,000 collected repeatedly from
-- 05:35 to 07:13 on 2026-09-16), each one paying fresh 10% commission — the
-- source of the CFO's "commission rewarded" figures for ~30 agents that day.
--
-- WHY NOT JUST BRING BACK A PER-COLLECTION FLOAT DEBIT
-- The pre-2026-09-15 design paired an `agent_float_used_for_rent` cash_out
-- leg (wallet, float bucket) with a `tenant_repayment` cash_in leg to balance.
-- The current design pairs a `cash_receipt_in_transit` cash_in leg (agent, the
-- physical cash now in their custody) with a `tenant_repayment_collected`
-- cash_out leg (tenant, the receivable reduced) — this is the shape
-- `guard_rent_request_agent_updates` now trusts (see 20260916060000) and the
-- shape financial statements read (src/lib/incomeStatementServiceMap.ts,
-- src/hooks/useFinancialStatements.ts, several drizzle migrations). Simply
-- adding a float cash_out leg back on top would leave the transaction
-- unbalanced — create_ledger_transaction hard-rejects with "Transaction not
-- balanced" (total cash_in <> total cash_out) — and every collection would
-- fail outright. Reverting the current legs to restore the old pairing would
-- break the guard and the financial statements that depend on the new shape.
--
-- THE FIX
-- Keep the current (correct) ledger shape untouched. Instead:
--   1. Cap same-day collected cash at the agent's current float allowance:
--      today's agent_collections total + this amount must not exceed
--      float_balance. This is the "cumulative daily-collected-vs-float cap"
--      the freeze migration named as the alternative to per-collection debit,
--      and it directly bounds the e05d2e42 exposure (a 300,000 float now
--      backs at most 300,000/day, not 60M/3 days).
--   2. Reject a same agent+tenant+rent_request+amount collection recorded in
--      the last 2 minutes — this is the specific fingerprint of the
--      repeated-collection incident (same rent_request, same amount, every
--      10-90s) and is not caught by the daily cap alone if the float
--      allowance is large relative to one payment.
--   3. Wire the existing (unused) p_client_ref idempotency guard from
--      20260909180000 into both callers: AgentTenantCollectDialog.tsx (fresh
--      ref per Confirm click) and submit-offline-collection (reuses the
--      draft's own stable id). Neither caller passed it before this change,
--      so the guard existed in the database but did nothing in production.
--
-- UNFREEZE
-- With the daily cap and duplicate guard in place, the platform-wide freeze
-- is lifted by restoring real bodies for both functions.

CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment_internal(
  p_agent_id uuid, p_tenant_id uuid, p_rent_request_id uuid, p_amount numeric,
  p_notes text DEFAULT NULL::text,
  p_client_ref uuid DEFAULT NULL::uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_float_balance      numeric := 0;
  v_collected_today    numeric := 0;
  v_outstanding        numeric;
  v_txn_group          uuid;
  v_tracking_id        text;
  v_collection_id      uuid;
  v_landlord_id        uuid;
  v_landlord_name      text;
  v_new_status         text;
  v_commission_earned  numeric;
  v_current_status     text;
  v_total_repayment    numeric;
  v_amount_repaid      numeric;
  v_idempotency_key    text;
  v_legs               jsonb;
  v_total_commission   numeric;
  v_parent_agent_id    uuid;
  v_parent_override    numeric := 0;
  v_wallet_view        jsonb;
  v_whitelisted        boolean := false;
  v_fee                jsonb := jsonb_build_object('status','not_attempted');
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;

  INSERT INTO public.wallets_physical (user_id) VALUES (p_agent_id) ON CONFLICT (user_id) DO NOTHING;

  v_wallet_view := public.get_user_wallet_view(p_agent_id);
  v_float_balance := GREATEST(0, COALESCE((v_wallet_view ->> 'float_balance')::numeric, 0));

  IF v_float_balance < p_amount THEN
    RETURN jsonb_build_object(
      'success', false, 'error_code', 'INSUFFICIENT_FLOAT',
      'error', format('Insufficient wallet float. Available: %s, Requested: %s. Top up Agent Float Allocation for rent collections.',
        v_float_balance, p_amount),
      'strict_float', v_float_balance, 'cached_float', v_float_balance, 'requested', p_amount);
  END IF;

  -- Daily cap: float is a non-consuming allowance under the current design
  -- (see header). Bound total same-day collected cash by it.
  SELECT COALESCE(SUM(ac.amount), 0) INTO v_collected_today
    FROM public.agent_collections ac
   WHERE ac.agent_id = p_agent_id
     AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date = (now() AT TIME ZONE 'Africa/Kampala')::date;

  IF v_collected_today + p_amount > v_float_balance THEN
    RETURN jsonb_build_object(
      'success', false, 'error_code', 'DAILY_FLOAT_CAP_EXCEEDED',
      'error', format(
        'Today''s rent collections (%s) plus this payment (%s) would exceed your float allowance (%s). Ask Finance to top up your float, or resume tomorrow.',
        v_collected_today, p_amount, v_float_balance),
      'collected_today', v_collected_today, 'float_balance', v_float_balance, 'requested', p_amount);
  END IF;

  -- Duplicate-submission guard: same agent+tenant+rent_request+amount posted
  -- in the last 2 minutes almost never reflects two independent tenant
  -- payments (see header for the confirmed live pattern).
  IF EXISTS (
    SELECT 1 FROM public.agent_collections ac
     WHERE ac.agent_id = p_agent_id
       AND ac.tenant_id = p_tenant_id
       AND ac.rent_request_id = p_rent_request_id
       AND ac.amount = p_amount
       AND ac.created_at > now() - interval '2 minutes'
  ) THEN
    RETURN jsonb_build_object(
      'success', false, 'error_code', 'DUPLICATE_SUBMISSION_SUSPECTED',
      'error', 'An identical payment for this tenant was just recorded seconds ago. Refresh the tenant balance before submitting again.');
  END IF;

  SELECT rr.landlord_id, l.name, rr.status, COALESCE(rr.total_repayment,0), COALESCE(rr.amount_repaid,0)
    INTO v_landlord_id, v_landlord_name, v_current_status, v_total_repayment, v_amount_repaid
    FROM public.rent_requests rr
    LEFT JOIN public.landlords l ON l.id = rr.landlord_id
   WHERE rr.id = p_rent_request_id AND rr.tenant_id = p_tenant_id;

  IF v_landlord_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent request not found');
  END IF;

  v_outstanding := GREATEST(0, v_total_repayment - v_amount_repaid);

  IF p_amount > v_outstanding THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'AMOUNT_EXCEEDS_OUTSTANDING',
      'error', format('Amount exceeds outstanding balance (%s).', v_outstanding));
  END IF;

  -- UNCHANGED: existing 10% commission, 8/2 split, whitelist override.
  v_total_commission := round(p_amount * 0.10, 2);

  SELECT sa.parent_agent_id INTO v_parent_agent_id
    FROM public.agent_subagents sa
   WHERE sa.sub_agent_id = p_agent_id
     AND sa.status IN ('verified', 'approved', 'accepted')
     AND sa.parent_agent_id <> p_agent_id
   LIMIT 1;

  v_whitelisted := public.is_subagent_commission_whitelisted(p_agent_id);

  IF v_parent_agent_id IS NOT NULL AND NOT v_whitelisted THEN
    v_commission_earned := round(p_amount * 0.08, 2);
    v_parent_override   := v_total_commission - v_commission_earned;
  ELSE
    v_commission_earned := v_total_commission;
    v_parent_override   := 0;
  END IF;

  v_idempotency_key := format('agent_allocate_tenant_payment:%s:%s:%s:%s:%s:%s',
    p_agent_id, p_tenant_id, p_rent_request_id, p_amount,
    extract(epoch from clock_timestamp())::text, gen_random_uuid()::text);

  -- Current design (2026-09-15+): float is a non-consuming eligibility
  -- allowance, capped above by the daily check, so no wallet-float leg is
  -- written. These legs are the ones financial statements / cash-flow views
  -- and the allocation-trust guard actually read — do not rename, remove, or
  -- pair a float debit against them (see header for why that unbalances the
  -- transaction).
  v_legs := jsonb_build_array(
    jsonb_build_object('user_id', p_agent_id, 'amount', p_amount, 'direction', 'cash_in',
      'category', 'cash_receipt_in_transit', 'ledger_scope', 'platform', 'classification', 'production',
      'description', 'Tenant rent cash received by agent — held in custody, not yet banked',
      'linked_party', v_landlord_id, 'source_table', 'agent_collections', 'source_id', p_rent_request_id),
    jsonb_build_object('user_id', p_tenant_id, 'amount', p_amount, 'direction', 'cash_out',
      'category', 'tenant_repayment_collected', 'ledger_scope', 'platform', 'classification', 'production',
      'description', format('Tenant rent allocation settled for landlord %s', COALESCE(v_landlord_name, 'Unknown')),
      'linked_party', v_landlord_id, 'source_table', 'agent_collections', 'source_id', p_rent_request_id),
    jsonb_build_object('user_id', p_agent_id, 'amount', v_commission_earned, 'direction', 'cash_in',
      'category', 'agent_commission_earned', 'ledger_scope', 'wallet', 'classification', 'production',
      'description', CASE WHEN v_whitelisted AND v_parent_agent_id IS NOT NULL
                          THEN 'Full 10% commission on rent collection (whitelisted sub-agent)'
                          ELSE '10% commission on rent collection allocation' END,
      'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
      'source_table', 'agent_collections', 'source_id', p_rent_request_id),
    jsonb_build_object('user_id', p_agent_id, 'amount', v_total_commission, 'direction', 'cash_out',
      'category', 'agent_commission_payable', 'ledger_scope', 'platform', 'classification', 'production',
      'description', 'Platform commission payout',
      'source_table', 'agent_collections', 'source_id', p_rent_request_id)
  );

  IF v_parent_agent_id IS NOT NULL AND v_parent_override > 0 THEN
    v_legs := v_legs || jsonb_build_array(
      jsonb_build_object('user_id', v_parent_agent_id, 'amount', v_parent_override, 'direction', 'cash_in',
        'category', 'agent_commission_earned', 'ledger_scope', 'wallet', 'classification', 'production',
        'description', '2% recruiter override on sub-agent rent collection allocation',
        'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
        'source_table', 'agent_collections', 'source_id', p_rent_request_id));
  END IF;

  PERFORM public.create_ledger_transaction(v_legs, v_idempotency_key);

  UPDATE public.rent_requests
     SET amount_repaid = COALESCE(amount_repaid,0) + p_amount,
         status = CASE
                    WHEN COALESCE(amount_repaid,0) + p_amount >= COALESCE(total_repayment,0) THEN 'completed'
                    WHEN status IN ('disbursed', 'funded', 'approved') THEN 'repaying'
                    ELSE status END,
         updated_at = now()
   WHERE id = p_rent_request_id
  RETURNING status INTO v_new_status;

  v_txn_group   := gen_random_uuid();
  v_tracking_id := 'AGT-' || substr(v_txn_group::text, 1, 8);

  -- float_before/float_after are equal: float is not debited per collection
  -- under the current design (the daily cap above is what bounds it).
  INSERT INTO public.agent_collections (
    agent_id, tenant_id, rent_request_id, amount, payment_method,
    float_before, float_after, tracking_id, notes, client_ref
  ) VALUES (
    p_agent_id, p_tenant_id, p_rent_request_id, p_amount, 'cash'::collection_payment_method,
    v_float_balance, v_float_balance, v_tracking_id, p_notes, p_client_ref
  )
  RETURNING id INTO v_collection_id;

  -- UNCHANGED: Landlord/Rent fee allocation (L7 -> R1 by fee type). No cash leg.
  BEGIN
    v_fee := public.post_rent_fee_collection(
      p_rent_request_id, p_amount, 'agent_collections', v_collection_id);
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.rent_fee_collection_exceptions
        (rent_request_id, collection_id, source_table, payment_amount, reason, detail)
      VALUES (p_rent_request_id, v_collection_id, 'agent_collections', p_amount,
              'fee_posting_failed', jsonb_build_object('sqlerrm', left(SQLERRM, 400)))
      ON CONFLICT (source_table, collection_id, reason) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    v_fee := jsonb_build_object('status','error','detail', left(SQLERRM, 200));
  END;

  RETURN jsonb_build_object(
    'success', true, 'collection_id', v_collection_id, 'transaction_group', v_txn_group,
    'tracking_id', v_tracking_id, 'amount', p_amount, 'amount_allocated', p_amount,
    'float_before', v_float_balance, 'float_after', v_float_balance,
    'wallet_float_before', v_float_balance, 'wallet_float_after', v_float_balance,
    'collected_today', v_collected_today + p_amount, 'float_allowance', v_float_balance,
    'commission', jsonb_build_object('credited_commission', v_commission_earned,
      'recruiter_override', v_parent_override, 'full_commission_whitelisted', v_whitelisted),
    'fee_allocation', v_fee, 'client_ref', p_client_ref,
    'new_status', v_new_status, 'outstanding_before', v_outstanding,
    'outstanding_remaining', GREATEST(0, v_outstanding - p_amount),
    'outstanding_after', GREATEST(0, v_outstanding - p_amount),
    'landlord_name', v_landlord_name);
END;
$function$;

CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment(
  p_agent_id uuid, p_tenant_id uuid, p_rent_request_id uuid, p_amount numeric,
  p_notes text DEFAULT NULL::text,
  p_partial_confirmed boolean DEFAULT false,
  p_partial_reason text DEFAULT NULL::text,
  p_client_ref uuid DEFAULT NULL::uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid; v_assigned uuid;
  v_expected numeric; v_shortfall numeric;
  v_is_partial boolean := false;
  v_reason text := NULLIF(btrim(COALESCE(p_partial_reason, '')), '');
  v_result jsonb; v_collection_id uuid;
  v_starts_on date;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_prior record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_agent_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Agents may allocate payments only from their own wallet'
      USING ERRCODE = '42501';
  END IF;

  IF NOT (
    public.has_role(v_uid, 'agent'::public.app_role)
    OR public.has_role(v_uid, 'senior_agent'::public.app_role)
    OR public.has_role(v_uid, 'sub_agent'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'Agent role required' USING ERRCODE = '42501';
  END IF;

  -- IDEMPOTENCY. Only when the caller supplied a reference; NULL keeps the
  -- previous behaviour untouched. The advisory lock serialises same-ref
  -- callers so the check below is authoritative even under a concurrent
  -- replay; the partial unique index on client_ref is the backstop if one
  -- still slips past.
  IF p_client_ref IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('agent_collect:' || p_client_ref::text, 0));

    SELECT ac.id, ac.tracking_id, ac.amount, ac.created_at, ac.rent_request_id, ac.tenant_id
      INTO v_prior
      FROM public.agent_collections ac
     WHERE ac.client_ref = p_client_ref
     LIMIT 1;

    IF v_prior.id IS NOT NULL THEN
      -- Replay: return the ORIGINAL receipt and move no money.
      RETURN jsonb_build_object(
        'success', true, 'idempotent', true, 'client_ref', p_client_ref,
        'collection_id', v_prior.id, 'tracking_id', v_prior.tracking_id,
        'amount', v_prior.amount, 'amount_allocated', v_prior.amount,
        'processed_at', v_prior.created_at,
        'rent_request_id', v_prior.rent_request_id, 'tenant_id', v_prior.tenant_id,
        'note', 'Replay of an already-processed payment. No new collection, commission, rent allocation or fee allocation was created.');
    END IF;
  END IF;

  SELECT rr.agent_id, rr.assigned_agent_id INTO v_owner, v_assigned
    FROM public.rent_requests rr
   WHERE rr.id = p_rent_request_id AND rr.tenant_id = p_tenant_id;

  IF v_owner IS NULL AND v_assigned IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent request not found');
  END IF;

  IF v_uid IS DISTINCT FROM v_owner
     AND v_uid IS DISTINCT FROM v_assigned
     AND NOT EXISTS (
       SELECT 1 FROM public.agent_subagents sa
        WHERE sa.parent_agent_id = v_uid
          AND sa.sub_agent_id IN (v_owner, v_assigned)
          AND sa.status IN ('verified','approved','accepted')
     ) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_YOUR_TENANT',
      'error', 'This tenant is no longer assigned to you. Refresh your list.');
  END IF;

  SELECT COALESCE(rr.repayment_starts_on,
           (COALESCE(rr.funded_at, rr.disbursed_at, rr.created_at) AT TIME ZONE 'Africa/Kampala')::date)
    INTO v_starts_on
    FROM public.rent_requests rr WHERE rr.id = p_rent_request_id;

  IF v_starts_on IS NOT NULL AND v_today < v_starts_on THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'REPAYMENT_NOT_STARTED',
      'error', format('Repayment for this Rent Plan starts on %s. Collection opens then.',
                      to_char(v_starts_on, 'DD Mon YYYY')),
      'repayment_starts_on', v_starts_on,
      'days_until_start', (v_starts_on - v_today));
  END IF;

  v_expected := COALESCE(public.agent_expected_collection(p_rent_request_id), 0);
  v_shortfall := GREATEST(0, v_expected - COALESCE(p_amount, 0));
  v_is_partial := v_expected > 0 AND COALESCE(p_amount, 0) < v_expected;

  v_result := public.agent_allocate_tenant_payment_internal(
    p_agent_id, p_tenant_id, p_rent_request_id, p_amount, p_notes, p_client_ref);

  IF COALESCE((v_result->>'success')::boolean, false) THEN
    v_collection_id := NULLIF(v_result->>'collection_id', '')::uuid;
    IF v_collection_id IS NOT NULL THEN
      UPDATE public.agent_collections
         SET expected_amount = v_expected,
             shortfall_amount = v_shortfall,
             is_partial = v_is_partial,
             partial_reason = CASE WHEN v_is_partial THEN v_reason ELSE partial_reason END
       WHERE id = v_collection_id;
    END IF;

    BEGIN
      PERFORM public.rent_apply_collections_to_days(p_rent_request_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'rent day attribution failed for plan %: %', p_rent_request_id, SQLERRM;
    END;

    v_result := v_result || jsonb_build_object(
      'expected_amount', v_expected, 'shortfall_amount', v_shortfall,
      'is_partial', v_is_partial,
      'partial_reason', CASE WHEN v_is_partial THEN v_reason ELSE NULL END);
  END IF;

  RETURN v_result;
END;
$function$;

-- Assertions ----------------------------------------------------------
DO $$
DECLARE v_n integer; v_src text;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='agent_allocate_tenant_payment';
  IF v_n <> 1 THEN RAISE EXCEPTION 'wrapper overload ambiguity: %', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='agent_allocate_tenant_payment_internal';
  IF v_n <> 1 THEN RAISE EXCEPTION 'internal overload ambiguity: %', v_n; END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='agent_allocate_tenant_payment_internal';
  IF position('ALLOCATION_FROZEN' in v_src) > 0 THEN
    RAISE EXCEPTION 'freeze was not lifted on the internal function';
  END IF;
  IF position('DAILY_FLOAT_CAP_EXCEEDED' in v_src) = 0 THEN
    RAISE EXCEPTION 'daily float cap missing';
  END IF;
  IF position('DUPLICATE_SUBMISSION_SUSPECTED' in v_src) = 0 THEN
    RAISE EXCEPTION 'duplicate-submission guard missing';
  END IF;
  IF position('tenant_repayment_collected' in v_src) = 0 THEN
    RAISE EXCEPTION 'guard-trusted receivable leg was dropped';
  END IF;
  IF position('cash_receipt_in_transit' in v_src) = 0 THEN
    RAISE EXCEPTION 'custody-cash leg was dropped (financial statements read this)';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='agent_allocate_tenant_payment';
  IF position('ALLOCATION_FROZEN' in v_src) > 0 THEN
    RAISE EXCEPTION 'freeze was not lifted on the wrapper';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
    AND indexname='agent_collections_client_ref_key') THEN
    RAISE EXCEPTION 'client_ref unique index missing';
  END IF;
END $$;
