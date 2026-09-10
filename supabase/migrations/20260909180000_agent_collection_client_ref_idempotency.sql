-- Payment-level idempotency for the ONLINE agent collection flow.
--
-- THE PROBLEM
-- agent_allocate_tenant_payment had no idempotency key. Its internal ledger key
-- embeds clock_timestamp() AND gen_random_uuid(), so no two calls are ever
-- deduplicated. Proven in test: two identical calls produced 2 collections,
-- 2 allocations, 2 commissions and amount_repaid +20,000 for one 10,000 payment.
--
-- The online client defends by never retrying - it caps the wait at 45s then
-- reconciles rather than re-issuing ("issue it exactly once and wait for the
-- result"). That is deliberate and documented, but it is client-side discipline,
-- not a server guarantee: two genuine API calls always produce two collections.
--
-- WHY THE KEY MUST COME FROM THE CALLER
-- A natural key (tenant + plan + amount + day) would wrongly block a tenant's
-- legitimate second payment of the same amount on the same day. That is exactly
-- why the server-generated key was made deliberately unique. Only the caller
-- knows whether a request is a NEW payment or a REPLAY of one, so the caller
-- must supply the reference.
--
-- THE PATTERN REUSED - not invented
-- submit-offline-collection already does this correctly, per CFO mandate:
--   "We are idempotent on `draft_id` - replays from a flaky network can never
--    double-count cash. We persist the (draft_id -> server receipt) mapping in
--    `offline_collection_submissions` so a retry returns the same receipt."
-- backed by a real UNIQUE index:
--   offline_collection_submissions_draft_id_key ON (draft_id)
-- It checks BEFORE moving money and returns the original receipt on replay.
--
-- agent_collections already carries the same shape for an external reference:
--   agent_collections_deposit_request_id_key ON (deposit_request_id)
--     WHERE deposit_request_id IS NOT NULL
-- so client_ref follows that established convention rather than adding a table.
--
-- WHY A COLUMN AND NOT A NEW TABLE
-- The agent_collections row IS the receipt. A separate mapping table would
-- duplicate it and add a second thing to keep consistent. One nullable column
-- plus one partial unique index is the smallest safe change.
--
-- CONCURRENCY
-- The pre-check alone would race: two simultaneous replays could both pass it.
-- Two independent defences:
--   1. pg_advisory_xact_lock on the client_ref serialises same-ref callers, so
--      the pre-check is authoritative (same technique create_ledger_transaction
--      uses for its idempotency key).
--   2. The partial UNIQUE index is the backstop. If a race still reached the
--      INSERT, the second transaction aborts and its money movement rolls back
--      entirely - exactly one payment survives.
--
-- BACKWARD COMPATIBILITY
-- p_client_ref is a trailing parameter defaulting to NULL. Existing callers -
-- AgentTenantCollectDialog (7 named args) and submit-offline-collection - are
-- unaffected and keep today's behaviour exactly. Both functions must be
-- DROPped and recreated because Postgres cannot add a parameter in place, and
-- leaving the old arity behind would make existing calls ambiguous. Done in one
-- transaction, so the swap is atomic.
--
-- DELIBERATELY NOT CHANGED
-- A2 semantics, agent_float accounting, A1/A5 Treasury routing,
-- compute_rent_repayment, the 10% commission rule, the
-- principal/access/registration allocation, legacy-plan scope. No historical
-- data is touched, no corrective entry is made, and the two verified production
-- payments (Nakawuki Winnfred 14,000, Elton Christine 43,000) are not modified.

-- 1. The caller-supplied reference ---------------------------------------
ALTER TABLE public.agent_collections
  ADD COLUMN IF NOT EXISTS client_ref uuid;

COMMENT ON COLUMN public.agent_collections.client_ref IS
  'Caller-supplied idempotency reference for one payment event. NULL keeps legacy behaviour. Enforced unique by agent_collections_client_ref_key so a replay cannot create a second collection.';

CREATE UNIQUE INDEX IF NOT EXISTS agent_collections_client_ref_key
  ON public.agent_collections (client_ref) WHERE client_ref IS NOT NULL;

-- 2. Internal allocator: accept and stamp the reference ------------------
DROP FUNCTION IF EXISTS public.agent_allocate_tenant_payment(uuid, uuid, uuid, numeric, text, boolean, text);
DROP FUNCTION IF EXISTS public.agent_allocate_tenant_payment_internal(uuid, uuid, uuid, numeric, text);

CREATE FUNCTION public.agent_allocate_tenant_payment_internal(
  p_agent_id uuid, p_tenant_id uuid, p_rent_request_id uuid, p_amount numeric,
  p_notes text DEFAULT NULL::text,
  p_client_ref uuid DEFAULT NULL::uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_float_balance      numeric := 0;
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

  -- UNCHANGED: A2 leg, A3 leg, commission legs. A2 direction and semantics are
  -- deliberately untouched; the unresolved float model is a separate workstream.
  v_legs := jsonb_build_array(
    jsonb_build_object('user_id', p_agent_id, 'amount', p_amount, 'direction', 'cash_out',
      'category', 'agent_float_used_for_rent', 'ledger_scope', 'wallet', 'classification', 'production',
      'description', 'Tenant rent collection from agent wallet float',
      'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
      'linked_party', v_landlord_id, 'source_table', 'agent_collections', 'source_id', p_rent_request_id),
    jsonb_build_object('user_id', p_tenant_id, 'amount', p_amount, 'direction', 'cash_in',
      'category', 'tenant_repayment', 'ledger_scope', 'platform', 'classification', 'production',
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
  RETURNING status INTO v_new_status;

  v_txn_group   := gen_random_uuid();
  v_tracking_id := 'AGT-' || substr(v_txn_group::text, 1, 8);

  -- client_ref is stamped ON INSERT so agent_collections_client_ref_key rejects
  -- a duplicate at the moment it is written, not afterwards.
  INSERT INTO public.agent_collections (
    agent_id, tenant_id, rent_request_id, amount, payment_method,
    float_before, float_after, tracking_id, notes, client_ref
  ) VALUES (
    p_agent_id, p_tenant_id, p_rent_request_id, p_amount, 'cash'::collection_payment_method,
    v_float_balance, GREATEST(0, v_float_balance - p_amount), v_tracking_id, p_notes, p_client_ref
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
    'float_before', v_float_balance, 'float_after', GREATEST(0, v_float_balance - p_amount),
    'wallet_float_before', v_float_balance, 'wallet_float_after', GREATEST(0, v_float_balance - p_amount),
    'commission', jsonb_build_object('credited_commission', v_commission_earned,
      'recruiter_override', v_parent_override, 'full_commission_whitelisted', v_whitelisted),
    'fee_allocation', v_fee, 'client_ref', p_client_ref,
    'new_status', v_new_status, 'outstanding_before', v_outstanding,
    'outstanding_remaining', GREATEST(0, v_outstanding - p_amount),
    'outstanding_after', GREATEST(0, v_outstanding - p_amount),
    'landlord_name', v_landlord_name);
END;
$function$;

-- 3. Public wrapper: idempotent pre-check --------------------------------
CREATE FUNCTION public.agent_allocate_tenant_payment(
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
      -- Replay: return the ORIGINAL receipt and move no money. Mirrors
      -- submit-offline-collection, which returns the stored receipt for a
      -- repeated draft_id.
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

-- 4. Assertions ----------------------------------------------------------
DO $$
DECLARE v_n integer;
BEGIN
  -- Exactly one overload of each: no ambiguity for existing 7-arg / 5-arg calls.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='agent_allocate_tenant_payment';
  IF v_n <> 1 THEN RAISE EXCEPTION 'wrapper overload ambiguity: %', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='agent_allocate_tenant_payment_internal';
  IF v_n <> 1 THEN RAISE EXCEPTION 'internal overload ambiguity: %', v_n; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
    AND indexname='agent_collections_client_ref_key') THEN
    RAISE EXCEPTION 'client_ref unique index missing';
  END IF;

  -- A2 leg and the 10% commission rule must be byte-present and unchanged.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='agent_allocate_tenant_payment_internal'
     AND position('agent_float_used_for_rent' in p.prosrc) > 0
     AND position('''wallet_bucket'', ''float''' in p.prosrc) > 0
     AND position('round(p_amount * 0.10, 2)' in p.prosrc) > 0
     AND position('round(p_amount * 0.08, 2)' in p.prosrc) > 0;
  IF v_n <> 1 THEN RAISE EXCEPTION 'A2 leg or commission rule was altered'; END IF;

  -- Pricing and allocation must be untouched by this migration.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname IN
     ('compute_rent_repayment','compute_instalment_allocation','allocate_instalment',
      'post_rent_fee_collection','is_treasury_waterfall_scope');
  IF v_n < 5 THEN RAISE EXCEPTION 'supporting functions missing: %', v_n; END IF;

  -- The two verified production collections must be untouched and unstamped.
  SELECT count(*) INTO v_n FROM public.agent_collections
   WHERE id IN ('c4da4d49-b184-4efb-b63c-8af0e933a599','a08141b9-be6f-4f30-a85f-898ec5a7fdc6')
     AND client_ref IS NULL;
  IF v_n <> 2 THEN RAISE EXCEPTION 'verified production collections were altered'; END IF;
END $$;
