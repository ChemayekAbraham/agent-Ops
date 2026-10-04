-- =====================================================================
-- Landlord Treasury fee cash transfer  (A2 custody -> A5 Treasury pool)
-- =====================================================================
-- REQUIREMENT
--   A tenant rent payment lands in the collecting agent's cash custody (A2).
--   The portion of that ACTUAL CASH belonging to Platform Treasury
--   (Registration Fee + Access Fee) must physically move A2 -> A5 so that
--   Treasury Cash (A1 + A5) rises by exactly the amount transferred, while the
--   landlord principal stays in A2.
--
-- THIS IS A CASH CUSTODY MOVEMENT ONLY.
--   It creates no fee allocation, no revenue entry, no second recognition, and
--   never recalculates a fee. The amount is read from the components already
--   stored in instalment_allocations by the existing allocation flow.
--
-- LEDGER SHAPE (one balanced group, existing categories only)
--   CR A2  platform.agent_float_cash_offset   cash_out   reg + access
--   DR A5  platform.cash_receipt_in_transit   cash_in    reg + access
--   raw: cash_out = cash_in      mapped: CR A2 = DR A5
--
-- PROVEN INVARIANTS (rolled-back tests on a real plan, 10,000 payment)
--   collection:  A2 +10,000 / A3 -10,000 / L1 -1,000 / L7 +3,007 / R1 -3,007 / X3 +1,000
--   transfer:    A2 -3,007  / A5 +3,007
--   net:         A2 +6,993 (= principal), A5 +3,007 (= 699 + 2,308)
--   Treasury delta (A1+A5)        = +3,007  (exactly the fees)
--   Total cash delta (A1+A2+A5)   =  0      (no cash created, no double count)
--   every account delta sums to    0
--
-- SOURCE TRACKING
--   source_table = 'agent_collections', source_id = agent_collections.id.
--   Deliberately NOT 'deposit_requests': fin_ops_set_cash_location and
--   approve-deposit both filter their guards on source_table='deposit_requests',
--   so these legs are invisible to the deposit flow and cannot disturb it.
--
-- IDEMPOTENCY
--   Idempotency key 'treasury_fee_transfer:agent_collections:<collection_id>'.
--   create_ledger_transaction takes pg_advisory_xact_lock(hashtext(key)) and
--   returns the pre-existing transaction_group_id when the key is already
--   present, so retries post nothing. A pre-check additionally reports
--   'already_transferred' without touching the ledger.
--
-- NOT CHANGED: pricing, compute_rent_repayment, enforce_rent_request_formula,
--   instalment_allocations calculation, post_rent_fee_collection, tenant
--   collection amount, deposit flow, approve-deposit,
--   fin_ops_set_cash_location, A5 -> A1 banking, ledger categories, Treasury
--   account structure, fee classification, revenue recognition, agent
--   operational float rules (both legs are platform scope, so
--   wallet_route_for_category and INSUFFICIENT_FLOAT are untouched),
--   non-landlord flows. No new account, no new category, no backfill.
--
-- A5 -> A1 banking is deliberately OUT OF SCOPE: A5 is already inside
--   Treasury Cash = A1 + A5, so the requirement is met at A5. Moving A5 -> A1
--   is an internal Treasury movement and is a separate future workflow.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.post_treasury_fee_cash_transfer(p_collection_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_reg numeric; v_access numeric; v_amount numeric;
  v_rent_request_id uuid; v_grp uuid; v_existing uuid; v_ref text;
BEGIN
  IF p_collection_id IS NULL THEN
    RETURN jsonb_build_object('status','skipped_no_collection');
  END IF;

  -- Use the components ALREADY stored by the existing allocation flow.
  -- Never recalculate a fee and never call a pricing function.
  SELECT ia.rent_request_id,
         COALESCE(ia.registration_fee_component, 0),
         COALESCE(ia.access_fee_component, 0)
    INTO v_rent_request_id, v_reg, v_access
  FROM public.instalment_allocations ia
  WHERE ia.source_table = 'agent_collections'
    AND ia.source_id = p_collection_id
  LIMIT 1;

  IF v_rent_request_id IS NULL THEN
    RETURN jsonb_build_object('status','skipped_no_allocation');
  END IF;

  v_amount := ROUND(v_reg + v_access, 2);

  -- A pure-principal instalment owes Treasury nothing. Never post a zero-value
  -- transaction (create_ledger_transaction rejects amount <= 0 anyway).
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('status','skipped_zero_treasury_amount',
      'registration_fee', v_reg, 'access_fee', v_access);
  END IF;

  -- Explicit pre-check so retries report cleanly. The idempotency_key passed to
  -- create_ledger_transaction remains the authoritative exactly-once guard.
  SELECT gl.transaction_group_id INTO v_existing
  FROM public.general_ledger gl
  WHERE gl.source_table = 'agent_collections'
    AND gl.source_id = p_collection_id
    AND gl.ledger_scope = 'platform'
    AND gl.category = 'cash_receipt_in_transit'
    AND gl.direction = 'cash_in'
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('status','already_transferred',
      'transaction_group_id', v_existing, 'treasury_amount', v_amount);
  END IF;

  v_ref := 'RENTFEE-' || left(p_collection_id::text, 8);

  v_grp := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'ledger_scope','platform','direction','cash_out',
        'category','agent_float_cash_offset','amount', v_amount,
        'description','Treasury fee cash released from agent custody (registration + access fee)',
        'source_table','agent_collections','source_id', p_collection_id,
        'reference_id', v_ref, 'classification','production'),
      jsonb_build_object(
        'ledger_scope','platform','direction','cash_in',
        'category','cash_receipt_in_transit','amount', v_amount,
        'description','Treasury: landlord rent fee cash received into Platform Treasury pool',
        'source_table','agent_collections','source_id', p_collection_id,
        'reference_id', v_ref, 'classification','production')
    ),
    'treasury_fee_transfer:agent_collections:' || p_collection_id::text
  );

  RETURN jsonb_build_object('status','posted', 'transaction_group_id', v_grp,
    'treasury_amount', v_amount, 'registration_fee', v_reg, 'access_fee', v_access,
    'rent_request_id', v_rent_request_id);
END;
$fn$;

COMMENT ON FUNCTION public.post_treasury_fee_cash_transfer(uuid) IS
  'Moves the Treasury-owned cash portion of a landlord rent collection out of '
  'the agent''s A2 custody into the A5 Treasury pool (CR A2 agent_float_cash_offset / '
  'DR A5 cash_receipt_in_transit) for exactly registration_fee_component + '
  'access_fee_component as already stored in instalment_allocations. Cash custody '
  'movement only - no fee allocation, no revenue entry, no recalculation. '
  'Exactly-once per collection via idempotency key '
  'treasury_fee_transfer:agent_collections:<collection_id>.';

-- ---------------------------------------------------------------------
-- Wire it into the existing landlord collection flow, immediately after the
-- fee allocation has stored its components. Exception-wrapped: a bookkeeping
-- problem must never fail a tenant's rent payment.
-- ---------------------------------------------------------------------
-- NOTE: agent_allocate_tenant_payment_internal is re-created in full here
-- because the environment's SQL gateway rejects dynamic DO/EXECUTE DDL. The
-- only change versus the 20260909200000 version is the DECLARE of v_treasury,
-- the exception-wrapped post_treasury_fee_cash_transfer call after the fee
-- block, and 'treasury_transfer' in the returned payload.

CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment_internal(p_agent_id uuid, p_tenant_id uuid, p_rent_request_id uuid, p_amount numeric, p_notes text DEFAULT NULL::text, p_client_ref uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_float_balance numeric := 0; v_outstanding numeric; v_txn_group uuid; v_tracking_id text;
  v_collection_id uuid; v_landlord_id uuid; v_landlord_name text; v_new_status text;
  v_commission_earned numeric; v_current_status text; v_total_repayment numeric;
  v_amount_repaid numeric; v_idempotency_key text; v_legs jsonb; v_total_commission numeric;
  v_parent_agent_id uuid; v_parent_override numeric := 0; v_wallet_view jsonb;
  v_whitelisted boolean := false; v_fee jsonb := jsonb_build_object('status','not_attempted');
  v_treasury jsonb := jsonb_build_object('status','not_attempted');
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;

  INSERT INTO public.wallets_physical (user_id) VALUES (p_agent_id) ON CONFLICT (user_id) DO NOTHING;

  v_wallet_view := public.get_user_wallet_view(p_agent_id);
  v_float_balance := GREATEST(0, COALESCE((v_wallet_view ->> 'float_balance')::numeric, 0));

  IF v_float_balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INSUFFICIENT_FLOAT',
      'error', format('Insufficient wallet float. Available: %s, Requested: %s. Top up Agent Float Allocation for rent collections.',
        v_float_balance, p_amount),
      'strict_float', v_float_balance, 'cached_float', v_float_balance, 'requested', p_amount);
  END IF;

  SELECT rr.landlord_id, l.name, rr.status, COALESCE(rr.total_repayment,0), COALESCE(rr.amount_repaid,0)
    INTO v_landlord_id, v_landlord_name, v_current_status, v_total_repayment, v_amount_repaid
    FROM public.rent_requests rr LEFT JOIN public.landlords l ON l.id = rr.landlord_id
   WHERE rr.id = p_rent_request_id AND rr.tenant_id = p_tenant_id;

  IF v_landlord_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent request not found');
  END IF;

  v_outstanding := GREATEST(0, v_total_repayment - v_amount_repaid);

  IF p_amount > v_outstanding THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'AMOUNT_EXCEEDS_OUTSTANDING',
      'error', format('Amount exceeds outstanding balance (%s).', v_outstanding));
  END IF;

  v_total_commission := round(p_amount * 0.10, 2);

  SELECT sa.parent_agent_id INTO v_parent_agent_id
    FROM public.agent_subagents sa
   WHERE sa.sub_agent_id = p_agent_id
     AND sa.status IN ('verified', 'approved', 'accepted')
     AND sa.parent_agent_id <> p_agent_id LIMIT 1;

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
    jsonb_build_object('user_id', p_agent_id, 'amount', p_amount, 'direction', 'cash_in',
      'category', 'agent_float_used_for_rent', 'ledger_scope', 'wallet', 'classification', 'production',
      'description', 'Tenant rent cash collected and held by agent',
      'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
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
         status = CASE WHEN COALESCE(amount_repaid,0) + p_amount >= COALESCE(total_repayment,0) THEN 'completed'
                       WHEN status IN ('disbursed', 'funded', 'approved') THEN 'repaying'
                       ELSE status END,
         updated_at = now()
   WHERE id = p_rent_request_id RETURNING status INTO v_new_status;

  v_txn_group   := gen_random_uuid();
  v_tracking_id := 'AGT-' || substr(v_txn_group::text, 1, 8);

  INSERT INTO public.agent_collections (
    agent_id, tenant_id, rent_request_id, amount, payment_method,
    float_before, float_after, tracking_id, notes, client_ref
  ) VALUES (
    p_agent_id, p_tenant_id, p_rent_request_id, p_amount, 'cash'::collection_payment_method,
    v_float_balance, v_float_balance + p_amount, v_tracking_id, p_notes, p_client_ref
  ) RETURNING id INTO v_collection_id;

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

  -- Move the Treasury-owned cash (registration + access fee) out of the agent's
  -- A2 custody into the A5 Treasury pool. Cash custody movement only: the fee
  -- amount comes from the allocation already stored above and is never
  -- recalculated. Never fails a tenant payment.
  BEGIN
    v_treasury := public.post_treasury_fee_cash_transfer(v_collection_id);
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.rent_fee_collection_exceptions
        (rent_request_id, collection_id, source_table, payment_amount, reason, detail)
      VALUES (p_rent_request_id, v_collection_id, 'agent_collections', p_amount,
              'treasury_transfer_failed', jsonb_build_object('sqlerrm', left(SQLERRM, 400)))
      ON CONFLICT (source_table, collection_id, reason) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    v_treasury := jsonb_build_object('status','error','detail', left(SQLERRM, 200));
  END;

  RETURN jsonb_build_object(
    'success', true, 'collection_id', v_collection_id, 'transaction_group', v_txn_group,
    'tracking_id', v_tracking_id, 'amount', p_amount, 'amount_allocated', p_amount,
    'float_before', v_float_balance, 'float_after', v_float_balance + p_amount,
    'wallet_float_before', v_float_balance, 'wallet_float_after', v_float_balance + p_amount,
    'commission', jsonb_build_object('credited_commission', v_commission_earned,
      'recruiter_override', v_parent_override, 'full_commission_whitelisted', v_whitelisted),
    'fee_allocation', v_fee, 'treasury_transfer', v_treasury, 'client_ref', p_client_ref,
    'new_status', v_new_status, 'outstanding_before', v_outstanding,
    'outstanding_remaining', GREATEST(0, v_outstanding - p_amount),
    'outstanding_after', GREATEST(0, v_outstanding - p_amount),
    'landlord_name', v_landlord_name);
END;
$fn$;
