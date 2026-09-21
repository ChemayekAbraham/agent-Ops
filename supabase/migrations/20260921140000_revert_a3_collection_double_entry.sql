-- REVERT 20260921120000 (the A3 "correct double entry" change).
--
-- WHY
-- 20260921120000 was built on a wrong premise. It judged the A3 direction from
-- `ledger_account_map` alone. But `sofp_ledger_legs` applies shape-dependent
-- overrides that rewrite `debit_when` per group, and for agent collections they
-- ALREADY invert the raw mapping:
--
--   * platform tenant_repayment_collected / tenant_repayment / rent_repayment /
--     landlord_receivable_collected have debit_when FLIPPED when the group
--     contains a wallet A2 leg (n_a2 > 0)               - resolver ~L90-94
--   * a wallet A2 leg gets dw := dir when n_repay > 0   - resolver ~L95-96
--
-- So the ORIGINAL four-leg shape already resolved correctly:
--
--   agent_float_used_for_rent  wallet cash_out  raw CR A2  -> resolved DR A2
--   tenant_repayment_collected platform cash_in raw DR A3  -> resolved CR A3
--   agent_commission_earned    wallet cash_in              -> CR L1
--   agent_commission_payable   platform cash_out           -> DR X3
--
--   mapped DR = mapped CR, and A3 is CREDITED by a tenant repayment.
--
-- Verified on live groups 41b62237 and d23ad7a4 (both 2026-09-21 08:28 UTC).
--
-- WHAT THE A3 MIGRATION WOULD HAVE DONE
-- Its six-leg shape still satisfies both override conditions, so the overrides
-- fire again and double-correct:
--   DR A2 X + DR A8 X + DR A5 X + DR X3 C  =  3X + C
--   CR A3 X + CR L1 C                      =   X + C
-- Unbalanced by 2X per collection. And because raw_net = 0, the `one_sided`
-- -> E4 counterpart does NOT fire, `trg_enforce_ledger_group_balance` only
-- checks cash direction, and `mapped_balance_mode = 'log'` makes the DR/CR
-- trigger advisory - so the trial balance would have broken silently.
--
-- BLAST RADIUS: NONE
-- Zero collections occurred between the A3 migration (2026-09-21 08:30:41 UTC)
-- and this revert. Zero `cash_receipt_in_transit` legs and zero platform
-- `agent_float_used_for_rent` legs were posted from the collection path. The
-- 186 legs booked against agent_collections in that window are all from the
-- unrelated `void_unverified_collection` process. No ledger row, wallet,
-- rent_request or agent_collections row was created or modified by
-- 20260921120000.
--
-- SCOPE OF THIS FILE
-- Function definitions, one ledger_account_map row, and guard/baseline
-- metadata only. No ledger row is modified. No wallet balance, tenant
-- repayment amount, rent plan or collection behaviour changes. No accounting
-- correction is posted.

BEGIN;

-- 1. Mapping: platform agent_float_used_for_rent back to A3 -----------------
UPDATE public.ledger_account_map
   SET account_code = 'A3'
 WHERE ledger_scope = 'platform'
   AND category     = 'agent_float_used_for_rent'
   AND account_code = 'A8';

-- 2. Allocator: restore the exact pre-A3-migration body ---------------------
-- Byte-for-byte the definition that was live until 2026-09-21 08:30:41 UTC
-- (prosrc length 9270), i.e. 20260916120000 as amended by 20260917100000
-- (one commission rate source of truth). The collection logic is NOT
-- redesigned: the A8 and A5 legs are removed and tenant_repayment_collected
-- returns to cash_in.
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

-- 3. Guard: back to the working shape, and STRICTLY STRONGER ---------------
-- `custody_leg_absent` is restored with its original meaning (A5 must not
-- appear - its presence is drizzle 0114). A second check is ADDED:
-- `platform_float_leg_absent`. The platform float leg was harmless before it
-- existed, but we now know that with the resolver overrides its presence
-- produces a 2x mapped DR/CR imbalance that nothing else catches. Together
-- with `float_is_consumed`, which is unchanged and still requires the WALLET
-- float leg, the canonical four-leg shape is pinned from both sides.
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

  RETURN QUERY SELECT 'custody_leg_absent', coalesce(position('cash_receipt_in_transit' in v_alloc)=0,false),
    'presence means drizzle 0114 was re-applied and float is no longer consumed';
  RETURN QUERY SELECT 'platform_float_leg_absent',
    coalesce(position('''agent_float_used_for_rent'', ''ledger_scope'', ''platform''' in v_alloc)=0,false),
    'sofp_ledger_legs already resolves the wallet float leg to DR A2 and flips the repayment leg to CR A3; adding a platform float counterpart double-counts the debit and unbalances mapped DR/CR by 2x the collection, which raw_net=0 hides from the one_sided/E4 net';
  RETURN QUERY SELECT 'not_frozen', coalesce(position('ALLOCATION_FROZEN' in v_alloc)=0,false),
    'the emergency stub blocks every agent';
  RETURN QUERY SELECT 'guard_trusts_float_leg', coalesce(position('agent_float_used_for_rent' in v_guard)>0,false),
    'the guard must still recognise the shape the allocator writes';
  RETURN QUERY SELECT 'single_overload',
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='agent_allocate_tenant_payment_internal')=1,
    'two overloads means an undeclared deploy added one';
END $function$;

-- 4. Verify, then move the baselines with the revert ------------------------
DO $verify$
DECLARE v_failed text;
BEGIN
  SELECT string_agg(check_name, ', ') INTO v_failed
    FROM public.assert_money_path_intact() WHERE NOT ok;
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'Revert refused: money path not intact (%). Rolling back.', v_failed
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
           baselined_by    = 'migration 20260921140000',
           note            = 're-baselined by the A3 revert (20260921140000)'
     WHERE function_signature = v_sig;
    IF NOT FOUND THEN
      RAISE NOTICE 'no baseline row for %', v_sig;
    END IF;
  END LOOP;
END
$rebaseline$;

COMMIT;
