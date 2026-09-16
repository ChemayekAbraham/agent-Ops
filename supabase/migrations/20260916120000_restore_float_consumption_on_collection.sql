-- Restore float consumption on rent collection, and make a silent repayment
-- failure impossible.
--
-- WHAT WENT WRONG
-- On 2026-09-15 15:12 UTC `agent_allocate_tenant_payment_internal` was
-- redesigned directly in production (drizzle 0114, committed to the repo 51
-- minutes later) so that agent float became a non-consuming eligibility gate:
-- the `agent_float_used_for_rent` wallet-float leg was dropped and
-- `float_before = float_after` was written into every receipt.
--
-- Three controls failed together:
--   1. `guard_rent_request_agent_updates` trusted a collection only when it saw
--      that float leg. With the leg gone it silently reverted
--      `rent_requests.amount_repaid` to its old value - no exception, so the
--      RPC returned success and paid commission anyway.
--   2. Outstanding therefore never fell, so `AMOUNT_EXCEEDS_OUTSTANDING` could
--      not stop a repeat, and the agent's screen never showed progress.
--   3. Float was never consumed, so `INSUFFICIENT_FLOAT` could not stop it
--      either, and `client_ref` was still not being sent by the dialog.
--
-- 2026-09-16 alone: 1,616 collections against 249 plans, UGX 136,621,549
-- recorded of which UGX 97,489,004 was duplicate, and ~UGX 9.7M of commission
-- overpaid across 31 agents. One plan (ba5f0105) took 169 collections
-- totalling 32.5M while its `amount_repaid` moved by almost nothing.
--
-- This is the THIRD time this exact shape of failure has been hit - see
-- 20260910100000, which documents the same "deployed straight to production
-- with no migration" incident on 10 September and says plainly: "A guard that
-- is edited to match a bug stops being a guard."
--
-- WHAT THIS RESTORES
-- The collection posting shape that ran until the cutoff, verified against a
-- real 2026-09-14 collection of 39,000:
--
--   agent_float_used_for_rent   cash_out  wallet/float   -> agent float falls
--   tenant_repayment_collected  cash_in   platform       -> settles the plan
--   agent_commission_earned     cash_in   wallet         -> 10% (8% + 2% split)
--   agent_commission_payable    cash_out  platform
--
-- The `cash_receipt_in_transit` (A5) leg 0114 introduced is dropped: under this
-- model the platform already received the money when the agent topped up float,
-- so booking custody again at collection time counts the same cash twice.
--
-- WHAT IS NEW
-- `FOR UPDATE` on the plan row, and a post-update assertion. The guard is a
-- BEFORE trigger that REWRITES `NEW.amount_repaid` rather than raising, so the
-- only way a caller can know its write was rejected is to read the row back and
-- compare. If the repayment did not land, this now raises and the whole
-- transaction - collection, commission and all - rolls back. Commission can
-- never again be paid for a repayment that did not happen.
--
-- STILL OPEN, deliberately not decided here
-- `tenant_repayment_collected` posts cash_in, which maps to a DEBIT of A3 and
-- so raises the tenant receivable where it should fall. 0114 identified this
-- correctly. Fixing it needs the A2 classification settled first - agent-funded
-- float is a liability to the agent, platform-advanced float is an asset, and
-- both currently share one bucket - so it is Phase 2, with the CFO, not a
-- change smuggled into an incident fix.

-- 1. The allocator ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment_internal(
  p_agent_id uuid, p_tenant_id uuid, p_rent_request_id uuid, p_amount numeric,
  p_notes text DEFAULT NULL::text,
  p_client_ref uuid DEFAULT NULL::uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_float_balance numeric := 0; v_outstanding numeric; v_txn_group uuid; v_tracking_id text;
  v_collection_id uuid; v_landlord_id uuid; v_landlord_name text; v_new_status text;
  v_commission_earned numeric; v_current_status text; v_total_repayment numeric;
  v_amount_repaid numeric; v_applied_repaid numeric; v_idempotency_key text;
  v_legs jsonb; v_total_commission numeric;
  v_parent_agent_id uuid; v_parent_override numeric := 0; v_wallet_view jsonb;
  v_whitelisted boolean := false;
  v_fee jsonb := jsonb_build_object('status','not_attempted');
  v_treasury jsonb := jsonb_build_object('status','not_attempted');
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;

  INSERT INTO public.wallets_physical (user_id) VALUES (p_agent_id) ON CONFLICT (user_id) DO NOTHING;

  v_wallet_view := public.get_user_wallet_view(p_agent_id);
  v_float_balance := GREATEST(0, COALESCE((v_wallet_view ->> 'float_balance')::numeric, 0));

  -- Float is cash the agent has pre-funded and is about to spend on this
  -- tenant's rent. It is consumed below, so this ceiling is real: an agent
  -- holding 20,000 can settle at most 20,000 before topping up again.
  IF v_float_balance < p_amount THEN
    RETURN jsonb_build_object(
      'success', false, 'error_code', 'INSUFFICIENT_FLOAT',
      'error', format('Insufficient wallet float. Available: %s, Requested: %s. Top up Agent Float Allocation for rent collections.',
        v_float_balance, p_amount),
      'strict_float', v_float_balance, 'cached_float', v_float_balance, 'requested', p_amount);
  END IF;

  -- Duplicate-submission guard, ported from Josh Wanda's 20260916130000.
  -- client_ref stops the SAME attempt arriving twice; it cannot stop an agent
  -- tapping Confirm again after the screen looked stuck, because that gets a
  -- fresh reference. This closes that gap: same agent+tenant+plan+amount inside
  -- two minutes is a re-tap, not two independent tenant payments.
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

  SELECT rr.landlord_id, l.name, rr.status
    INTO v_landlord_id, v_landlord_name, v_current_status
    FROM public.rent_requests rr
    LEFT JOIN public.landlords l ON l.id = rr.landlord_id
   WHERE rr.id = p_rent_request_id AND rr.tenant_id = p_tenant_id;

  IF v_landlord_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent request not found');
  END IF;

  -- Lock the plan for the rest of this transaction. Two agents (or two taps)
  -- collecting on the same plan at once now queue instead of both reading the
  -- same outstanding balance and both passing the check below.
  SELECT COALESCE(rr.total_repayment, 0), COALESCE(rr.amount_repaid, 0)
    INTO v_total_repayment, v_amount_repaid
    FROM public.rent_requests rr
   WHERE rr.id = p_rent_request_id
     FOR UPDATE;

  v_outstanding := GREATEST(0, v_total_repayment - v_amount_repaid);

  IF p_amount > v_outstanding THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'AMOUNT_EXCEEDS_OUTSTANDING',
      'error', format('Amount exceeds outstanding balance (%s).', v_outstanding));
  END IF;

  -- UNCHANGED: 10% total, 8/2 split with a verified parent, whitelist override.
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

  v_legs := jsonb_build_array(
    -- The agent spends their own float to settle this tenant's rent. This leg
    -- is also what `guard_rent_request_agent_updates` looks for before it will
    -- trust the amount_repaid write below - shape, scope, bucket, recipient
    -- type and amount all have to match exactly.
    jsonb_build_object('user_id', p_agent_id, 'amount', p_amount, 'direction', 'cash_out',
      'category', 'agent_float_used_for_rent', 'ledger_scope', 'wallet', 'classification', 'production',
      'description', 'Tenant rent collection from agent wallet float',
      'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
      'linked_party', v_landlord_id, 'source_table', 'agent_collections', 'source_id', p_rent_request_id),
    jsonb_build_object('user_id', p_tenant_id, 'amount', p_amount, 'direction', 'cash_in',
      'category', 'tenant_repayment_collected', 'ledger_scope', 'platform', 'classification', 'production',
      'description', format('Tenant rent allocation settled for landlord %s', COALESCE(v_landlord_name, 'Unknown')),
      'linked_party', v_landlord_id, 'source_table', 'agent_collections', 'source_id', p_rent_request_id),
    jsonb_build_object('user_id', p_agent_id, 'amount', v_commission_earned, 'direction', 'cash_in',
      'category', 'agent_commission_earned', 'ledger_scope', 'wallet', 'classification', 'production',
      'description', CASE WHEN v_whitelisted AND v_parent_agent_id IS NOT NULL
                          THEN 'Full 10% commission on rent collection (whitelisted sub-agent)'
                          ELSE '10% commission on rent collection allocation' END,
      'recipient_type', 'user', 'source_table', 'agent_collections', 'source_id', p_rent_request_id),
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
        'recipient_type', 'user', 'source_table', 'agent_collections', 'source_id', p_rent_request_id));
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
  RETURNING COALESCE(amount_repaid, 0), status INTO v_applied_repaid, v_new_status;

  -- THE ASSERTION THAT WAS MISSING.
  -- guard_rent_request_agent_updates is a BEFORE trigger that rewrites
  -- NEW.amount_repaid back to OLD when it does not trust the write. It raises
  -- nothing, so a caller that does not read the row back cannot tell. Reading
  -- it back and failing loudly is what stops commission ever again being paid
  -- for a repayment that did not happen: this raise rolls the whole
  -- transaction back, ledger legs included.
  IF v_applied_repaid IS DISTINCT FROM v_amount_repaid + p_amount THEN
    RAISE EXCEPTION
      'Rent collection refused: the repayment was not applied (expected %, got %). No money was moved.',
      v_amount_repaid + p_amount, v_applied_repaid
      USING ERRCODE = '55000';
  END IF;

  v_txn_group   := gen_random_uuid();
  v_tracking_id := 'AGT-' || substr(v_txn_group::text, 1, 8);

  -- float_after records the consumption. client_ref is stamped ON INSERT so
  -- agent_collections_client_ref_key rejects a replay as it is written.
  INSERT INTO public.agent_collections (
    agent_id, tenant_id, rent_request_id, amount, payment_method,
    float_before, float_after, tracking_id, notes, client_ref
  ) VALUES (
    p_agent_id, p_tenant_id, p_rent_request_id, p_amount, 'cash'::collection_payment_method,
    v_float_balance, GREATEST(0, v_float_balance - p_amount), v_tracking_id, p_notes, p_client_ref
  )
  RETURNING id INTO v_collection_id;

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

  -- The fee slice of the cash the agent is holding moves A2 -> A5 (see
  -- 20260910060000). 0114 skipped this because the whole collection was landing
  -- in A5; with that leg gone it is required again. Its own idempotency key
  -- makes a repeat a no-op, and a failure here must not void the collection.
  BEGIN
    v_treasury := public.post_treasury_fee_cash_transfer(v_collection_id);
  EXCEPTION WHEN OTHERS THEN
    v_treasury := jsonb_build_object('status','error','detail', left(SQLERRM, 200));
  END;

  RETURN jsonb_build_object(
    'success', true, 'collection_id', v_collection_id, 'transaction_group', v_txn_group,
    'tracking_id', v_tracking_id, 'amount', p_amount, 'amount_allocated', p_amount,
    'float_before', v_float_balance, 'float_after', GREATEST(0, v_float_balance - p_amount),
    'wallet_float_before', v_float_balance, 'wallet_float_after', GREATEST(0, v_float_balance - p_amount),
    'commission', jsonb_build_object('credited_commission', v_commission_earned,
      'recruiter_override', v_parent_override, 'full_commission_whitelisted', v_whitelisted),
    'fee_allocation', v_fee, 'treasury_transfer', v_treasury, 'client_ref', p_client_ref,
    'new_status', v_new_status, 'outstanding_before', v_outstanding,
    'outstanding_remaining', GREATEST(0, v_outstanding - p_amount),
    'outstanding_after', GREATEST(0, v_outstanding - p_amount),
    'landlord_name', v_landlord_name);
END;
$function$;

-- 2. Public wrapper: unfreeze, with the client_ref pre-check ----------------
-- Both this and the allocator were replaced in production by a stub returning
-- ALLOCATION_FROZEN while the runaway was stopped. Restoring this definition is
-- what lets agents collect again, so it is applied LAST, after the allocator
-- has been proven.
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
  -- previous behaviour untouched. The advisory lock serialises same-ref callers
  -- so the check below is authoritative even under a concurrent replay; the
  -- partial unique index on client_ref is the backstop if one still slips past.
  IF p_client_ref IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('agent_collect:' || p_client_ref::text, 0));

    SELECT ac.id, ac.tracking_id, ac.amount, ac.created_at, ac.rent_request_id, ac.tenant_id
      INTO v_prior
      FROM public.agent_collections ac
     WHERE ac.client_ref = p_client_ref
     LIMIT 1;

    IF v_prior.id IS NOT NULL THEN
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

-- 3. Assertions ------------------------------------------------------------
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='agent_allocate_tenant_payment_internal'
     AND position('agent_float_used_for_rent' in p.prosrc) > 0
     AND position('''wallet_bucket'', ''float''' in p.prosrc) > 0
     AND position('''recipient_type'', ''operational_wallet''' in p.prosrc) > 0
     AND position('round(p_amount * 0.10, 2)' in p.prosrc) > 0
     AND position('round(p_amount * 0.08, 2)' in p.prosrc) > 0
     AND position('the repayment was not applied' in p.prosrc) > 0
     AND position('cash_receipt_in_transit' in p.prosrc) = 0;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'allocator does not have the restored shape (float leg / commission rule / assertion)';
  END IF;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='agent_allocate_tenant_payment_internal';
  IF v_n <> 1 THEN RAISE EXCEPTION 'internal overload ambiguity: %', v_n; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
    AND indexname='agent_collections_client_ref_key') THEN
    RAISE EXCEPTION 'client_ref unique index missing';
  END IF;

  -- The freeze must be gone from BOTH entry points, or agents stay blocked.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN ('agent_allocate_tenant_payment','agent_allocate_tenant_payment_internal')
     AND position('ALLOCATION_FROZEN' in p.prosrc) > 0;
  IF v_n <> 0 THEN RAISE EXCEPTION 'allocation is still frozen in % function(s)', v_n; END IF;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='agent_allocate_tenant_payment';
  IF v_n <> 1 THEN RAISE EXCEPTION 'wrapper overload ambiguity: %', v_n; END IF;
END $$;
