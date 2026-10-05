-- A3 tenant-collection accounting: post the correct double entry.
--
-- FORWARD-ONLY. No historical ledger row is read, rewritten or reversed here.
-- No wallet balance, float behaviour, repayment calculation, pricing,
-- commission rate or landlord payout behaviour changes.
--
-- THE DEFECT
-- `agent_allocate_tenant_payment_internal` posts, for a collection of X:
--     agent_float_used_for_rent   cash_out  wallet/float  -> CR A2
--     tenant_repayment_collected  cash_in   platform      -> DR A3
-- The group balances on cash direction, but the A3 leg is a DEBIT, so a tenant
-- repayment RAISES the tenant receivable, and total assets FALL by X on every
-- collection. The direction is not a free choice today: the float leg is the
-- group's only counterpart, so trg_enforce_ledger_group_balance forces the
-- tenant leg to cash_in. Flipping the mapping alone leaves two credits and no
-- debit.
--
-- WHY THE 2026-09-15 ATTEMPT FAILED (drizzle 0114, reverted by 20260916120000)
-- It dropped the float leg and added `cash_receipt_in_transit` (A5). Three
-- controls failed together: guard_rent_request_agent_updates silently reverted
-- amount_repaid, so AMOUNT_EXCEEDS_OUTSTANDING never fired; and with no float
-- consumed, INSUFFICIENT_FLOAT could not fire either. 2026-09-16 alone: 1,616
-- collections against 249 plans, UGX 97,489,004 duplicated, ~UGX 9.7M of
-- commission overpaid across 31 agents. The revert recorded the A5 leg as
-- double-counting, which was correct FOR THAT SHAPE: A5 rose while A2 never
-- fell.
--
-- WHAT THIS DOES DIFFERENTLY
-- It keeps the float leg exactly as it is and adds the two platform legs the
-- entry was always missing, so A2 falls by the same amount A5 rises. Nothing is
-- counted twice, and every control that keys on the float leg keeps working.
--
--   agent_float_used_for_rent   cash_out  wallet/float  -> CR A2   (unchanged)
--   agent_float_used_for_rent   cash_in   platform      -> DR A8   (new)
--   tenant_repayment_collected  cash_out  platform      -> CR A3   (flipped)
--   cash_receipt_in_transit     cash_in   platform      -> DR A5   (new)
--   agent_commission_earned     cash_in   wallet        -> CR L1   (unchanged)
--   agent_commission_payable    cash_out  platform      -> DR X3   (unchanged)
--
-- For X = 10,000 with 10% commission:
--   cash_in  = 10,000 (A8) + 10,000 (A5) + 1,000 = 21,000
--   cash_out = 10,000 (float) + 10,000 (A3) + 1,000 = 21,000
--   DR = A8 10,000 + A5 10,000 + X3 1,000 = 21,000
--   CR = A2 10,000 + A3 10,000 + L1 1,000 = 21,000
--   Net assets: A2 -10,000, A8 +10,000, A3 -10,000, A5 +10,000 = 0
--
-- WHY A8 IS THE ECONOMIC COUNTERPART, NOT A BALANCING ACCOUNT
-- A8 "Agent and Merchant Float Cycle Control" is already the designated
-- platform counterpart for the ENTIRE float lifecycle. Verified in production
-- `ledger_account_map`: agent_float_assignment, agent_float_deposit,
-- agent_float_settlement, agent_float_topup and agent_float_funding all pair
-- wallet/A2 against platform/A8. `agent_float_used_for_rent` is the ONLY float
-- category whose platform side is routed elsewhere (A3) - that is the anomaly
-- this migration removes.
--
-- The closest analogue is agent_float_settlement, which is economically
-- identical (float leaves the agent's float bucket) and posts wallet cash_out
-- -> CR A2 against platform cash_in -> DR A8, 10,818 legs / UGX 1,737,232,081
-- in production. `agent_float_used_for_rent` already has 21 platform cash_in
-- legs in production (UGX 1,916,400); they are simply routed to A3 today. The
-- leg shape is not new - only its destination account is corrected.
--
-- NOT DECIDED HERE (Phase 2)
-- Whether agent-funded float is a liability to the agent and platform-advanced
-- float an asset. Both share the A2 bucket. This entry is sign-neutral across
-- A2/A5/A8, so the A3 correction does not depend on that classification.
-- Historical corrections are also Phase 2 and are untouched by this file.
--
-- WALLET SAFETY
-- Both added legs are ledger_scope = 'platform'. tr_general_ledger_route_buckets
-- gates on ledger_scope = 'wallet' before calling apply_wallet_movement, so
-- neither leg can reach a wallet, a float bucket or a withdrawable balance.
-- The wallet float leg is byte-for-byte unchanged.

BEGIN;

-- 1. Route the platform float counterpart to A8, alongside its siblings ------
UPDATE public.ledger_account_map
   SET account_code = 'A8'
 WHERE ledger_scope = 'platform'
   AND category     = 'agent_float_used_for_rent'
   AND account_code = 'A3';

-- 2. The allocator ----------------------------------------------------------
-- Identical to the 20260916120000 body - FOR UPDATE on the plan row, the
-- post-update repayment assertion, get_agent_commission_rate as the single rate
-- source, the recruiter residual, the fee and treasury hand-offs and their
-- non-fatal exception handling are all preserved verbatim. Only the three leg
-- changes described above differ.
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
  v_rate jsonb;
  v_fee jsonb := jsonb_build_object('status','not_attempted');
  v_treasury jsonb := jsonb_build_object('status','not_attempted');
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

  SELECT rr.landlord_id, l.name, rr.status
    INTO v_landlord_id, v_landlord_name, v_current_status
    FROM public.rent_requests rr
    LEFT JOIN public.landlords l ON l.id = rr.landlord_id
   WHERE rr.id = p_rent_request_id AND rr.tenant_id = p_tenant_id;

  IF v_landlord_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent request not found');
  END IF;

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

  -- THE RATE IS NOT DECIDED HERE. `get_agent_commission_rate` is the single
  -- source of truth, and `get_my_commission_rate` shows the agent the same
  -- number BEFORE they collect. Re-inlining 0.10 / 0.08 here would let the
  -- screen and the wallet disagree again - assert_money_path_intact() fails
  -- if that happens.
  v_rate := public.get_agent_commission_rate(p_agent_id);
  v_parent_agent_id   := nullif(v_rate ->> 'recruiter_id', '')::uuid;
  v_whitelisted       := COALESCE((v_rate ->> 'whitelisted')::boolean, false);
  v_total_commission  := round(p_amount * (v_rate ->> 'total_rate')::numeric, 2);
  v_commission_earned := round(p_amount * (v_rate ->> 'agent_rate')::numeric, 2);
  -- The recruiter takes the RESIDUAL, never its own rounding. Rounding both
  -- sides independently can leave the two cash_in legs a cent short of the
  -- cash_out payable leg, and trg_enforce_ledger_group_balance would then
  -- refuse the whole collection.
  v_parent_override   := v_total_commission - v_commission_earned;

  v_idempotency_key := format('agent_allocate_tenant_payment:%s:%s:%s:%s:%s:%s',
    p_agent_id, p_tenant_id, p_rent_request_id, p_amount,
    extract(epoch from clock_timestamp())::text, gen_random_uuid()::text);

  v_legs := jsonb_build_array(
    -- Float consumed. UNCHANGED. guard_rent_request_agent_updates,
    -- INSUFFICIENT_FLOAT and the whole 2026-09-16 incident fix key on this leg.
    jsonb_build_object('user_id', p_agent_id, 'amount', p_amount, 'direction', 'cash_out',
      'category', 'agent_float_used_for_rent', 'ledger_scope', 'wallet', 'classification', 'production',
      'description', 'Tenant rent collection from agent wallet float',
      'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
      'linked_party', v_landlord_id, 'source_table', 'agent_collections', 'source_id', p_rent_request_id),
    -- NEW. The float cycle control counterpart (DR A8), the same pairing every
    -- other float category already uses. Platform scope: cannot touch a wallet.
    jsonb_build_object('user_id', p_agent_id, 'amount', p_amount, 'direction', 'cash_in',
      'category', 'agent_float_used_for_rent', 'ledger_scope', 'platform', 'classification', 'production',
      'description', 'Agent float cycle control - float applied to tenant rent',
      'linked_party', v_landlord_id, 'source_table', 'agent_collections', 'source_id', p_rent_request_id),
    -- FLIPPED to cash_out. The tenant has repaid, so the receivable FALLS (CR A3).
    -- guard_rent_request_agent_updates already trusts this exact shape through
    -- its v_receivable_reduced_matched branch, so the guard needs no change.
    jsonb_build_object('user_id', p_tenant_id, 'amount', p_amount, 'direction', 'cash_out',
      'category', 'tenant_repayment_collected', 'ledger_scope', 'platform', 'classification', 'production',
      'description', format('Tenant rent allocation settled for landlord %s', COALESCE(v_landlord_name, 'Unknown')),
      'linked_party', v_landlord_id, 'source_table', 'agent_collections', 'source_id', p_rent_request_id),
    -- NEW. The tenant's cash, now physically held by the agent (DR A5). A2 falls
    -- by the same amount on the float leg above, so nothing is counted twice.
    jsonb_build_object('user_id', p_agent_id, 'amount', p_amount, 'direction', 'cash_in',
      'category', 'cash_receipt_in_transit', 'ledger_scope', 'platform', 'classification', 'production',
      'description', 'Tenant rent cash received by agent - held in custody, not yet banked',
      'linked_party', p_tenant_id, 'source_table', 'agent_collections', 'source_id', p_rent_request_id),
    jsonb_build_object('user_id', p_agent_id, 'amount', v_commission_earned, 'direction', 'cash_in',
      'category', 'agent_commission_earned', 'ledger_scope', 'wallet', 'classification', 'production',
      'description', CASE WHEN v_whitelisted AND v_parent_agent_id IS NOT NULL
                          THEN 'Full 10% commission on rent collection (whitelisted sub-agent)'
                          ELSE format('%s commission on rent collection allocation', v_rate ->> 'label') END,
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

  IF v_applied_repaid IS DISTINCT FROM v_amount_repaid + p_amount THEN
    RAISE EXCEPTION
      'Rent collection refused: the repayment was not applied (expected %, got %). No money was moved.',
      v_amount_repaid + p_amount, v_applied_repaid
      USING ERRCODE = '55000';
  END IF;

  v_txn_group   := gen_random_uuid();
  v_tracking_id := 'AGT-' || substr(v_txn_group::text, 1, 8);

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
      'recruiter_override', v_parent_override, 'full_commission_whitelisted', v_whitelisted,
      'rate', (v_rate ->> 'agent_rate')::numeric,
      'rate_label', v_rate ->> 'label',
      'recruiter_rate', (v_rate ->> 'recruiter_rate')::numeric),
    'fee_allocation', v_fee, 'treasury_transfer', v_treasury, 'client_ref', p_client_ref,
    'new_status', v_new_status, 'outstanding_before', v_outstanding,
    'outstanding_remaining', GREATEST(0, v_outstanding - p_amount),
    'outstanding_after', GREATEST(0, v_outstanding - p_amount),
    'landlord_name', v_landlord_name);
END;
$function$;

-- 3. The drift detector -----------------------------------------------------
-- `custody_leg_absent` is NOT removed. It is replaced by a strictly stronger
-- invariant. The old check said "A5 must never appear", which also forbade the
-- correct shape. The new one says "A5 appears if and only if the platform float
-- leg appears", which still refuses the drizzle 0114 shape - A5 with no float
-- leg - while permitting the paired entry. Combined with `float_is_consumed`,
-- which is unchanged and guarantees the WALLET float leg, an A5-only allocator
-- cannot pass.
CREATE OR REPLACE FUNCTION public.assert_money_path_intact()
 RETURNS TABLE(check_name text, ok boolean, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_alloc text; v_guard text; v_rate_fn text;
BEGIN
  SELECT p.prosrc INTO v_alloc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='agent_allocate_tenant_payment_internal';
  SELECT p.prosrc INTO v_guard FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='guard_rent_request_agent_updates';
  SELECT p.prosrc INTO v_rate_fn FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_agent_commission_rate';

  RETURN QUERY SELECT 'allocator_exists', v_alloc IS NOT NULL, coalesce('length '||length(v_alloc)::text,'MISSING');
  RETURN QUERY SELECT 'float_is_consumed', coalesce(position('agent_float_used_for_rent' in v_alloc)>0,false),
    'the wallet float debit leg must be posted on every collection';
  RETURN QUERY SELECT 'float_leg_matches_guard', coalesce(position('''recipient_type'', ''operational_wallet''' in v_alloc)>0,false),
    'the guard matches on recipient_type=operational_wallet';
  RETURN QUERY SELECT 'repayment_is_verified', coalesce(position('the repayment was not applied' in v_alloc)>0,false),
    'stops commission being paid for a repayment that was reverted';
  RETURN QUERY SELECT 'plan_row_is_locked', coalesce(position('FOR UPDATE' in v_alloc)>0,false),
    'concurrent taps on one plan must queue';

  -- Commission: the rate lives in ONE function and the allocator must read it.
  RETURN QUERY SELECT 'rate_fn_exists', v_rate_fn IS NOT NULL,
    'get_agent_commission_rate is the single source of truth for the split';
  RETURN QUERY SELECT 'allocator_uses_shared_rate', coalesce(position('get_agent_commission_rate' in v_alloc)>0,false),
    'the allocator must not decide the rate itself';
  RETURN QUERY SELECT 'rate_not_reinlined_in_allocator',
    coalesce(position('round(p_amount * 0.10' in v_alloc)=0 AND position('round(p_amount * 0.08' in v_alloc)=0, false),
    'a constant back in the allocator means the screen can disagree with the wallet again';
  RETURN QUERY SELECT 'rate_fn_total_10_pct', coalesce(position('''total_rate'', 0.10' in v_rate_fn)>0,false),
    'total commission is 10% of the collection';
  RETURN QUERY SELECT 'rate_fn_subagent_8_pct', coalesce(position('''agent_rate'', 0.08' in v_rate_fn)>0,false),
    'a sub-agent keeps 8%, the recruiting parent takes 2%';
  RETURN QUERY SELECT 'rate_fn_honours_whitelist', coalesce(position('is_subagent_commission_whitelisted' in v_rate_fn)>0,false),
    'a whitelisted sub-agent keeps the full 10%';
  RETURN QUERY SELECT 'receipt_states_real_rate', coalesce(position('v_rate ->> ''label''' in v_alloc)>0,false),
    'the commission leg description must state the rate actually paid, not a hard-coded 10%';

  -- Replaces `custody_leg_absent`. A5 is permitted ONLY when paired with the
  -- platform float leg. A5 on its own is drizzle 0114, where float stopped
  -- being consumed and three controls failed together on 2026-09-16.
  RETURN QUERY SELECT 'custody_leg_paired_with_float',
    coalesce(
      (position('cash_receipt_in_transit' in v_alloc)>0)
        = (position('''agent_float_used_for_rent'', ''ledger_scope'', ''platform''' in v_alloc)>0),
      false),
    'the A5 custody leg may appear only alongside the platform float leg; A5 without it means drizzle 0114 was re-applied and float is no longer consumed';
  RETURN QUERY SELECT 'not_frozen', coalesce(position('ALLOCATION_FROZEN' in v_alloc)=0,false),
    'the emergency stub blocks every agent';
  RETURN QUERY SELECT 'guard_trusts_float_leg', coalesce(position('agent_float_used_for_rent' in v_guard)>0,false),
    'the guard must still recognise the shape the allocator writes';
  RETURN QUERY SELECT 'single_overload',
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='agent_allocate_tenant_payment_internal')=1,
    'two overloads means an undeclared deploy added one';
END $function$;

-- 4. Prove the money path is still intact, then re-baseline -----------------
-- A reviewed migration that changes a baselined function MUST move the
-- baseline with it, in the same transaction. That is precisely what an
-- unreviewed production edit does not do, which is what makes it detectable
-- by scan_critical_function_drift() within 15 minutes.
-- See 20260921110000 for why these functions are baselined at all.
DO $verify$
DECLARE v_failed text;
BEGIN
  SELECT string_agg(check_name, ', ')
    INTO v_failed
    FROM public.assert_money_path_intact()
   WHERE NOT ok;

  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION
      'A3 migration refused: the money path is not intact after the change (%). Rolling back.',
      v_failed
      USING ERRCODE = '55000';
  END IF;
END
$verify$;

DO $rebaseline$
DECLARE
  v_sig text;
  v_sigs text[] := ARRAY[
    'agent_allocate_tenant_payment_internal(uuid,uuid,uuid,numeric,text,uuid)',
    'assert_money_path_intact()'
  ];
BEGIN
  FOREACH v_sig IN ARRAY v_sigs LOOP
    UPDATE public.critical_function_baselines
       SET expected_sha256 = encode(sha256(convert_to(pg_get_functiondef(v_sig::regprocedure), 'UTF8')), 'hex'),
           baselined_at    = now(),
           baselined_by    = 'migration 20260921120000',
           -- Set, never append: appending would grow the note on every re-run.
           note            = 're-baselined by the A3 correct-double-entry migration (20260921120000)'
     WHERE function_signature = v_sig;

    IF NOT FOUND THEN
      RAISE NOTICE 'no baseline row for % - apply 20260921110000 first', v_sig;
    END IF;
  END LOOP;
END
$rebaseline$;

COMMIT;
