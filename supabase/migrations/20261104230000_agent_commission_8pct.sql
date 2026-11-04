-- Agent rent-collection commission: 10% -> 8% on every collection (2026-11-04)
--
-- Owner decision (Pius, 2026-11-04), from the Welile 360 model update of 2 Nov 2026:
--   * an agent with no parent earns 8% of each collection (was 10%);
--   * a sub-agent with a verified parent earns 6% (was 8%); the parent keeps 2%;
--   * whitelisted / elite-ranked sub-agents keep the full 8% (was the full 10%);
--   * applies to every collection from go-live, on running and new Rent Plans;
--   * the tenant's price is unchanged. The freed 2% stays with the platform for now.
--     TODO(cover-pool): send the released 2% to the Cover Pool once that account exists.
--     _release_unpaid_commission_budget is the single place to change.
--
-- Accounting. The four-part fee split (_post_four_part_fee_split) still funds a 10%
-- commission budget per Rent Plan out of the collected fees, and books its share of each
-- collection against the commission cost (agent_commission_payable -> X3 for agent
-- collections; agent_commission_settled -> L5 for tenant self-payments). Agents are now
-- paid 8%, so every path that pays commission and gets a posted fee split releases the
-- unpaid part of that budget in its own balanced, platform-only group:
--     DR <offset category> (X3 / L5)      CR platform_fee_collected (R1)
-- so commission cost nets to zero exactly as before and the 2% lands in Platform Fee.
-- The plan-level parts, the price and the split itself are untouched.
--
-- The release group for an agent collection is posted in the same transaction as the
-- collection and carries source_table='agent_collections', source_id=<rent_request_id>,
-- the same key admin_void_unverified_collection mirrors on, so a void reverses it too.
--
-- Not changed on purpose:
--   * agent_unallocate_tenant_payment, cfo_decide_agent_unallocation,
--     agent_reverse_tenant_allocation: they only reverse the old 'rent_payment_for_tenant'
--     / '%float allocation%' shapes (last one 2026-10-05), all paid at 10%, so a 10%
--     clawback is still the amount that was paid.
--   * rent_plan_waterfall_report / _exceptions / rent_fee_deposit_commission_duplicates:
--     they check the 10% plan-level commission budget, which is unchanged.
--   * rent_fee_correct_unsplit_agent_collections: scoped to 2026-09-08..09-10 collections.
--   * _post_instalment_waterfall_legacy (no use in 30 days) and the 360-day engine
--     (_v360_waterfall_core; v360 new plans are switched off).
--   * Rent Plan pricing (compute_rent_repayment and its /0.90 floor).


-- ---------------------------------------------------------------------------
-- 1. The single source of truth for the split.
--    assert_money_path_intact() looks for the literals 'total_rate', 0.08 and
--    'agent_rate', 0.06 below; keep them literal.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_agent_commission_rate(p_agent_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_parent uuid;
  v_whitelisted boolean := false;
BEGIN
  -- 8% of each collection since 2026-11-04 (was 10%).
  IF p_agent_id IS NULL THEN
    RETURN jsonb_build_object('agent_rate', 0.08, 'recruiter_rate', 0,
      'total_rate', 0.08, 'is_subagent', false, 'whitelisted', false,
      'recruiter_id', NULL, 'label', '8%');
  END IF;

  -- A link only counts when it is verified AND is not the agent pointing at themselves.
  SELECT sa.parent_agent_id INTO v_parent
    FROM public.agent_subagents sa
   WHERE sa.sub_agent_id = p_agent_id
     AND sa.status IN ('verified', 'approved', 'accepted')
     AND sa.parent_agent_id <> p_agent_id
   LIMIT 1;

  v_whitelisted := public.is_subagent_commission_whitelisted(p_agent_id);

  -- Sub-agent keeps 6%, the recruiting parent takes 2%.
  IF v_parent IS NOT NULL AND NOT v_whitelisted THEN
    RETURN jsonb_build_object(
      'agent_rate', 0.06, 'recruiter_rate', 0.02, 'total_rate', 0.08,
      'is_subagent', true, 'whitelisted', false,
      'recruiter_id', v_parent, 'label', '6%');
  END IF;

  -- No parent, or a whitelisted / elite sub-agent: the full 8%.
  RETURN jsonb_build_object(
    'agent_rate', 0.08, 'recruiter_rate', 0, 'total_rate', 0.08,
    'is_subagent', v_parent IS NOT NULL, 'whitelisted', COALESCE(v_whitelisted, false),
    'recruiter_id', v_parent, 'label', '8%');
END $function$;

-- The screens ask for the caller's own rate instead of assuming 10% (handover 58).
GRANT EXECUTE ON FUNCTION public.get_my_commission_rate() TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Release the unpaid part of the fee split's commission budget to Platform Fee.
--    Internal: owner + service_role only (closed by default; revoked explicitly).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._release_unpaid_commission_budget(
  p_budget          numeric,   -- commission booked by the fee split for this cash
  p_paid            numeric,   -- commission actually credited to agent wallets
  p_offset_category text,      -- the category the split credited the budget to
  p_source_table    text,
  p_source_id       text,
  p_reference_id    text,
  p_idempotency_key text
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_unpaid numeric := round(COALESCE(p_budget, 0) - COALESCE(p_paid, 0), 2);
  v_grp    uuid;
  v_desc   text;
BEGIN
  IF p_offset_category NOT IN ('agent_commission_payable', 'agent_commission_settled', 'marketing_expense') THEN
    RAISE EXCEPTION 'unsupported commission offset category %', p_offset_category;
  END IF;
  IF p_idempotency_key IS NULL OR p_source_table IS NULL THEN
    RAISE EXCEPTION 'idempotency key and source table are required';
  END IF;
  -- Nothing to release when the split booked no budget or the agent was paid all of it
  -- (a shortfall stays where it is today: in the commission cost).
  IF p_budget IS NULL OR v_unpaid <= 0 THEN
    RETURN jsonb_build_object('status', 'nothing_to_release', 'budget', p_budget, 'paid', p_paid);
  END IF;

  v_desc := format('Commission budget not paid out (agents earn 8%% of each collection): UGX %s released to Platform Fee',
                   to_char(v_unpaid, 'FM999,999,999,990.00'));

  v_grp := public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'direction', 'cash_out', 'amount', v_unpaid, 'category', p_offset_category,
        'ledger_scope', 'platform', 'classification', 'production', 'currency', 'UGX',
        'source_table', p_source_table, 'source_id', p_source_id, 'reference_id', p_reference_id,
        'description', v_desc),
      jsonb_build_object(
        'direction', 'cash_in', 'amount', v_unpaid, 'category', 'platform_fee_collected',
        'ledger_scope', 'platform', 'classification', 'production', 'currency', 'UGX',
        'source_table', p_source_table, 'source_id', p_source_id, 'reference_id', p_reference_id,
        'description', v_desc)),
    idempotency_key := p_idempotency_key);

  RETURN jsonb_build_object('status', 'released', 'amount', v_unpaid,
    'budget', p_budget, 'paid', p_paid, 'transaction_group_id', v_grp);
END $function$;

REVOKE ALL ON FUNCTION public._release_unpaid_commission_budget(numeric, numeric, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._release_unpaid_commission_budget(numeric, numeric, text, text, text, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Pay collection commission for edge-function paths (manual-collect-rent,
--    agent-deposit overflow) at the shared rate, with the parent split, instead of
--    a flat 10% computed in TypeScript. Optionally releases the unpaid budget.
--    service_role only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.credit_collection_commission(
  p_agent_id          uuid,
  p_amount            numeric,
  p_source_table      text,
  p_source_id         text,
  p_context           text,
  p_idempotency_key   text,
  p_commission_budget numeric DEFAULT NULL,
  p_offset_category   text DEFAULT 'agent_commission_payable'
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rate    jsonb;
  v_total   numeric;
  v_agent   numeric;
  v_parent  numeric;
  v_parent_id uuid;
  v_legs    jsonb;
  v_grp     uuid;
  v_release jsonb := jsonb_build_object('status', 'not_requested');
  v_ctx     text := left(COALESCE(NULLIF(btrim(p_context), ''), 'rent collection'), 120);
BEGIN
  IF p_agent_id IS NULL OR COALESCE(p_amount, 0) <= 0 THEN
    RETURN jsonb_build_object('status', 'no_op', 'total_commission', 0);
  END IF;
  IF p_idempotency_key IS NULL OR p_source_table IS NULL THEN
    RAISE EXCEPTION 'idempotency key and source table are required';
  END IF;

  v_rate      := public.get_agent_commission_rate(p_agent_id);
  v_parent_id := NULLIF(v_rate ->> 'recruiter_id', '')::uuid;
  v_total     := round(p_amount * (v_rate ->> 'total_rate')::numeric, 2);
  v_agent     := round(p_amount * (v_rate ->> 'agent_rate')::numeric, 2);
  v_parent    := v_total - v_agent;
  IF v_parent_id IS NULL OR v_parent <= 0 THEN
    v_agent := v_total; v_parent := 0;
  END IF;

  IF v_total > 0 THEN
    v_legs := jsonb_build_array(
      jsonb_build_object('user_id', p_agent_id, 'amount', v_agent, 'direction', 'cash_in',
        'category', 'agent_commission_earned', 'ledger_scope', 'wallet', 'wallet_bucket', 'withdrawable',
        'recipient_type', 'user', 'classification', 'production', 'currency', 'UGX',
        'source_table', p_source_table, 'source_id', p_source_id,
        'description', format('%s commission on %s', v_rate ->> 'label', v_ctx)),
      jsonb_build_object('user_id', p_agent_id, 'amount', v_total, 'direction', 'cash_out',
        'category', 'agent_commission_payable', 'ledger_scope', 'platform',
        'classification', 'production', 'currency', 'UGX',
        'source_table', p_source_table, 'source_id', p_source_id,
        'description', format('Platform commission expense: %s', v_ctx)));
    IF v_parent > 0 THEN
      v_legs := v_legs || jsonb_build_array(
        jsonb_build_object('user_id', v_parent_id, 'amount', v_parent, 'direction', 'cash_in',
          'category', 'agent_commission_earned', 'ledger_scope', 'wallet', 'wallet_bucket', 'withdrawable',
          'recipient_type', 'user', 'classification', 'production', 'currency', 'UGX',
          'source_table', p_source_table, 'source_id', p_source_id,
          'description', format('2%% recruiter override on sub-agent %s', v_ctx)));
    END IF;
    v_grp := public.create_ledger_transaction(entries := v_legs, idempotency_key := p_idempotency_key);
  END IF;

  IF p_commission_budget IS NOT NULL THEN
    v_release := public._release_unpaid_commission_budget(
      p_commission_budget, v_total, p_offset_category, p_source_table, p_source_id,
      NULL, 'commission-budget-release:' || p_idempotency_key);
  END IF;

  RETURN jsonb_build_object('status', CASE WHEN v_total > 0 THEN 'credited' ELSE 'no_commission' END,
    'total_commission', v_total, 'agent_commission', v_agent, 'parent_override', v_parent,
    'parent_agent_id', v_parent_id, 'rate_label', v_rate ->> 'label',
    'transaction_group_id', v_grp, 'budget_release', v_release);
END $function$;

REVOKE ALL ON FUNCTION public.credit_collection_commission(uuid, numeric, text, text, text, text, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_collection_commission(uuid, numeric, text, text, text, text, numeric, text) TO service_role;

-- Field deposits read their rate from this table (seeded at the old hard-coded 10%).
UPDATE public.field_deposit_commission_config
   SET rate = 0.08,
       notes = 'Agent commission 8% of each collection since 2026-11-04 (was 10%)',
       updated_at = now()
 WHERE is_active AND rate = 0.10;


-- ---------------------------------------------------------------------------
-- agent_allocate_tenant_payment_internal (live production text + 8% edits)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment_internal(p_agent_id uuid, p_tenant_id uuid, p_rent_request_id uuid, p_amount numeric, p_notes text DEFAULT NULL::text, p_client_ref uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
  v_release jsonb := jsonb_build_object('status','not_attempted');
  v_fee jsonb := jsonb_build_object('status','not_attempted');
  v_treasury jsonb := jsonb_build_object('status','not_attempted');
  v_tid_backed_balance numeric;
  v_tid_gate_effective timestamptz := '2026-09-22 00:00:00+03'::timestamptz;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  END IF;

  -- Fail fast on contended rows (weak-network retries / peak hours) with a
  -- retryable 55P03 instead of an 8s statement timeout. Transaction-scoped.
  PERFORM set_config('lock_timeout', '3s', true);
  -- One allocation per agent at a time, taken BEFORE the float is read, so
  -- float check, TID-backed lock and ledger legs always see one consistent
  -- state and lock order is fixed: agent -> Rent Plan -> ledger/wallets.
  PERFORM pg_advisory_xact_lock(hashtextextended('agent_float_alloc:' || p_agent_id::text, 0));
  -- Lock the Rent Plan row up front (single lock point, fixed order).
  PERFORM 1 FROM public.rent_requests WHERE id = p_rent_request_id FOR UPDATE;

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

  IF now() >= v_tid_gate_effective THEN
    SELECT balance INTO v_tid_backed_balance
      FROM public.agent_tid_backed_float
     WHERE agent_id = p_agent_id
     FOR UPDATE;
    v_tid_backed_balance := COALESCE(v_tid_backed_balance, 0);

    IF v_tid_backed_balance < p_amount THEN
      RETURN jsonb_build_object(
        'success', false, 'error_code', 'INSUFFICIENT_TID_BACKED_FLOAT',
        'error', format('Only deposits verified by a real transaction ID may fund rent collection. TID-backed balance: %s, Requested: %s. Deposit real money via MoMo/Airtel to continue collecting.',
          v_tid_backed_balance, p_amount),
        'tid_backed_balance', v_tid_backed_balance, 'requested', p_amount);
    END IF;
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

  v_rate := public.get_agent_commission_rate(p_agent_id);
  v_parent_agent_id   := nullif(v_rate ->> 'recruiter_id', '')::uuid;
  v_whitelisted       := COALESCE((v_rate ->> 'whitelisted')::boolean, false);
  v_total_commission  := round(p_amount * (v_rate ->> 'total_rate')::numeric, 2);
  v_commission_earned := round(p_amount * (v_rate ->> 'agent_rate')::numeric, 2);
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
                          THEN format('Full %s commission on rent collection (whitelisted sub-agent)', v_rate ->> 'label')
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

  PERFORM public.credit_agent_tid_backed_float(p_agent_id, -p_amount);

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

  -- 8% commission (2026-11-04): the fee split above funded a 10% commission budget for
  -- this cash and booked it against agent_commission_payable; agents were paid 8%.
  -- Release the unpaid part to Platform Fee in this same transaction, keyed like the
  -- collection legs (source_id = Rent Plan) so a void mirrors it with them.
  IF COALESCE(v_fee->>'status','') = 'posted' THEN
    BEGIN
      v_release := public._release_unpaid_commission_budget(
        (v_fee->>'agent_commission_accounting')::numeric, v_total_commission,
        'agent_commission_payable', 'agent_collections', p_rent_request_id::text,
        v_tracking_id, 'commission-budget-release:agent_collections:' || v_collection_id::text);
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        INSERT INTO public.rent_fee_collection_exceptions
          (rent_request_id, collection_id, source_table, payment_amount, reason, detail)
        VALUES (p_rent_request_id, v_collection_id, 'agent_collections', p_amount,
                'commission_budget_release_failed', jsonb_build_object('sqlerrm', left(SQLERRM, 400)))
        ON CONFLICT (source_table, collection_id, reason) DO NOTHING;
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
      v_release := jsonb_build_object('status','error','detail', left(SQLERRM, 200));
    END;
  END IF;

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
    'fee_allocation', v_fee, 'treasury_transfer', v_treasury, 'commission_budget_release', v_release, 'client_ref', p_client_ref,
    'new_status', v_new_status, 'outstanding_before', v_outstanding,
    'outstanding_remaining', GREATEST(0, v_outstanding - p_amount),
    'outstanding_after', GREATEST(0, v_outstanding - p_amount),
    'landlord_name', v_landlord_name);
END;
$function$
;


-- ---------------------------------------------------------------------------
-- assert_money_path_intact (live production text + 8% edits)
-- ---------------------------------------------------------------------------
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
  RETURN QUERY SELECT 'rate_fn_total_8_pct', coalesce(position('''total_rate'', 0.08' in v_rate_fn)>0,false),
    'total commission is 8% of the collection (since 2026-11-04)';
  RETURN QUERY SELECT 'rate_fn_subagent_6_pct', coalesce(position('''agent_rate'', 0.06' in v_rate_fn)>0,false),
    'a sub-agent keeps 6%, the recruiting parent takes 2%';
  RETURN QUERY SELECT 'rate_fn_honours_whitelist', coalesce(position('is_subagent_commission_whitelisted' in v_rate_fn)>0,false),
    'a whitelisted sub-agent keeps the full 8%';
  RETURN QUERY SELECT 'receipt_states_real_rate', coalesce(position('v_rate ->> ''label''' in v_alloc)>0,false),
    'the commission leg description must state the rate actually paid, not a hard-coded 10%';

  RETURN QUERY SELECT 'unpaid_budget_released', coalesce(position('_release_unpaid_commission_budget' in v_alloc)>0,false),
    'the fee split funds a 10% commission budget; the unpaid part must be released to Platform Fee or X3 goes negative';

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
END $function$
;


-- ---------------------------------------------------------------------------
-- post_instalment_waterfall (live production text + 8% edits)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_instalment_waterfall(p_rent_request_id uuid, p_instalment_amount numeric, p_source_table text, p_source_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_all_prior numeric; v_prior_paid numeric; v_paid numeric; v_res jsonb;
BEGIN
  PERFORM 1 FROM rent_requests WHERE id = p_rent_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'rent_request % not found', p_rent_request_id; END IF;
  IF COALESCE(p_instalment_amount,0) > 0 THEN
    v_res := public._rent_fee_refuse_cancelled(p_rent_request_id, p_instalment_amount, p_source_table, p_source_id);
    IF v_res IS NOT NULL THEN RETURN v_res; END IF;
  END IF;

  IF NOT public.is_four_part_waterfall_eligible(p_rent_request_id) THEN
    RETURN public._post_instalment_waterfall_legacy(p_rent_request_id, p_instalment_amount, p_source_table, p_source_id, p_idempotency_key);
  END IF;

  IF EXISTS (SELECT 1 FROM instalment_allocations ia
             WHERE ia.rent_request_id=p_rent_request_id
               AND ia.source_table=p_source_table AND ia.source_id=p_source_id) THEN
    RETURN jsonb_build_object('status','already_allocated');
  END IF;
  IF ROUND(COALESCE(p_instalment_amount,0), 2) <= 0 THEN
    RETURN jsonb_build_object('status','no_allocation');
  END IF;

  -- Deposit-route commission PAYMENT = the agent commission rate (8% since 2026-11-04,
  -- was 10%) of THIS deposit payment only.
  -- Prior agent-route collections (already paid 10% by agent_allocate_tenant_payment_internal)
  -- and reversed collections are deliberately NOT part of this calculation.
  -- (Pre-fix formula ROUND(10% x all split rows) - deposit-route commission paid
  --  re-paid 10% on earlier agent cash: UGX 42,200 on 9 plans to 2026-09-28.)
  v_all_prior := NULL; v_prior_paid := NULL;
  v_paid := ROUND(ROUND(p_instalment_amount) * (public.get_agent_commission_rate(NULL) ->> 'total_rate')::numeric);

  -- Paths whose caller pays commission separately through credit_agent_rent_commission
  -- (which books its own X3 cost) must not also accrue an L5 commission payable that is
  -- never settled. They take the agent-collection offset (X3) and report 0 commission,
  -- so nothing is paid from this result. Wallet behaviour is unchanged.
  -- manual_collect_rent added 2026-09-29: manual-collect-rent pays 10% itself and books X3.
  IF p_source_table IN ('subscription_charges','agent_deposits','tenant_pay_rent','manual_collect_rent') THEN
    v_res := public._post_four_part_fee_split(p_rent_request_id, p_instalment_amount, p_source_table, p_source_id,
               CASE WHEN p_source_table = 'manual_collect_rent' THEN 'agent_collection' ELSE 'engine_paid' END, NULL,
               COALESCE(p_idempotency_key, 'four-part-fee:' || p_source_table || ':' || p_source_id::text));
    v_paid := 0;
  ELSE
    v_res := public._post_four_part_fee_split(p_rent_request_id, p_instalment_amount, p_source_table, p_source_id,
               'deposit_settlement', v_paid,
               COALESCE(p_idempotency_key, 'four-part-fee:' || p_source_table || ':' || p_source_id::text));
  END IF;

  IF v_res->>'status' <> 'posted' THEN RETURN v_res; END IF;

  RETURN v_res || jsonb_build_object(
    'agent_commission', v_paid,
    'partner_reward_allocation', (v_res->>'partner_returns')::numeric,
    'platform_net', (v_res->>'platform_fee')::numeric,
    'registration', (v_res->>'registration_fee_collected')::numeric,
    'access', (v_res->>'access_fee_collected')::numeric);
END $function$
;


-- ---------------------------------------------------------------------------
-- settle_tenant_rent_from_deposit (live production text + 8% edits)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_tenant_rent_from_deposit(p_deposit_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dep            record;
  v_plan           record;
  v_rr             uuid;
  v_avail          numeric := 0;
  v_applied        numeric := 0;
  v_surplus        numeric := 0;
  v_parent_id      uuid;
  v_whitelisted    boolean := false;
  v_comm_total     numeric := 0;
  v_comm_agent     numeric := 0;
  v_comm_parent    numeric := 0;
  v_rate           jsonb := public.get_agent_commission_rate(NULL);
  v_release        jsonb;
  v_legs           jsonb;
  v_group_a        uuid;
  v_group_c        uuid;
  v_group_b        uuid;
  v_tracking       text;
  v_collection_id  uuid;
  v_repayment_id   uuid;
  v_new_status     text;
  v_is_agent_actor boolean := false;
  v_agent          record;
  v_reason         text;
  v_purpose        text;
  v_locked         record;
  v_out            numeric := 0;
  v_daily          numeric := 0;
  v_paid_today     numeric := 0;
  v_due            numeric := 0;
  v_in_scope       boolean := false;
  v_orch           jsonb;
  v_wf             jsonb;
  v_reg_count      integer := 0;
  v_reg_match      integer := 0;
  v_identity       text := 'unverified_no_registered_number';
  v_cached         numeric := 0;
  v_cached_f       numeric := 0;
  v_avail_w        numeric := 0;
  v_avail_f        numeric := 0;
  v_from_w         numeric := 0;
  v_from_f         numeric := 0;
  v_today          date;
  v_covered_days   integer := 0;
  v_paid_up_to     date;
  v_today_paid     numeric := 0;
  v_today_gap      numeric := 0;
  v_first_name     text;
  v_tenant_sms     text;
  v_agent_sms      text;
  v_out_after      numeric := 0;
BEGIN
  SELECT dr.id, dr.user_id, dr.amount, dr.status, dr.deposit_purpose::text AS purpose,
         dr.transaction_id, dr.provider, p.phone, p.full_name
    INTO v_dep
    FROM public.deposit_requests dr
    JOIN public.profiles p ON p.id = dr.user_id
   WHERE dr.id = p_deposit_request_id;

  IF NOT FOUND THEN
    INSERT INTO public.tenant_self_repayment_attempts (deposit_request_id, deposit_amount, outcome, reason)
    VALUES (p_deposit_request_id, 0, 'refused', 'no_profile_or_deposit')
    ON CONFLICT (deposit_request_id) DO UPDATE
      SET outcome = 'refused', reason = 'no_profile_or_deposit', updated_at = now();
    RETURN jsonb_build_object('success', false, 'reason', 'no_profile_or_deposit');
  END IF;

  IF v_dep.status <> 'approved' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'deposit_not_approved');
  END IF;

  IF EXISTS (SELECT 1 FROM public.repayments r WHERE r.deposit_request_id = p_deposit_request_id) THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true, 'reason', 'already_settled');
  END IF;

  v_purpose := lower(COALESCE(v_dep.purpose, ''));
  v_today   := (now() AT TIME ZONE 'Africa/Kampala')::date;

  IF COALESCE(NULLIF(trim(v_dep.phone), ''), '') = '' THEN
    v_reason := 'no_registered_phone';
  ELSE
    SELECT count(*),
           count(*) FILTER (
             WHERE public.normalize_phone_last9(udn.phone_last9)
                 = public.normalize_phone_last9(v_dep.phone))
      INTO v_reg_count, v_reg_match
      FROM public.user_deposit_numbers udn
     WHERE udn.user_id = v_dep.user_id;

    IF v_reg_count = 0 THEN
      v_identity := 'unverified_no_registered_number';
    ELSIF v_reg_match > 0 OR EXISTS (
      SELECT 1 FROM public.gmail_transactions gt
       WHERE gt.linked_deposit_request_id = p_deposit_request_id
         AND gt.direction = 'in'
         AND public.normalize_phone_last9(gt.counterparty)
           = public.normalize_phone_last9(v_dep.phone)
    ) THEN
      v_identity := 'verified_registered_number';
    ELSE
      v_identity := 'mismatch';
      v_reason   := 'payer_number_mismatch';
    END IF;
  END IF;

  IF v_reason IS NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.rent_requests rr
       WHERE rr.agent_id = v_dep.user_id
         AND rr.status IN ('repaying', 'disbursed', 'funded')
    ) OR EXISTS (
      SELECT 1 FROM public.agent_collections ac
       WHERE ac.agent_id = v_dep.user_id
    ) OR EXISTS (
      SELECT 1 FROM public.agent_float_limits fl
       WHERE fl.agent_id = v_dep.user_id
    ) INTO v_is_agent_actor;

    IF v_is_agent_actor AND v_purpose <> 'personal_rent_repayment' THEN
      v_reason := 'agent_float_deposit_not_rent_purpose';
    END IF;
  END IF;

  SELECT * INTO v_plan FROM public.tenant_self_repayment_plan(v_dep.user_id);
  v_rr := v_plan.rent_request_id;

  IF v_reason IS NULL AND v_rr IS NULL THEN
    v_reason := 'no_active_rent_plan';
  END IF;

  IF v_reason IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(v_rr::text, 0));

    SELECT COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0) AS outstanding,
           COALESCE(rr.daily_repayment, 0) AS daily
      INTO v_locked
      FROM public.rent_requests rr
     WHERE rr.id = v_rr
     FOR UPDATE;

    v_out   := GREATEST(0, COALESCE(v_locked.outstanding, 0));
    v_daily := GREATEST(0, COALESCE(v_locked.daily, 0));

    SELECT COALESCE(SUM(ac.amount), 0)
      INTO v_paid_today
      FROM public.agent_collections ac
     WHERE ac.rent_request_id = v_rr
       AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date = v_today;

    -- informational only from 2026-09-21: the applied amount is no longer capped
    -- at today's remaining daily amount. Paying ahead is supported by the
    -- day-by-day settlement rebuild, so the whole deposit is applied.
    v_due := CASE WHEN v_daily <= 0 THEN v_out
                  ELSE LEAST(v_out, GREATEST(0, v_daily - v_paid_today)) END;

    SELECT COALESCE(withdrawable_balance, 0), COALESCE(float_balance, 0)
      INTO v_cached, v_cached_f
      FROM public.wallets WHERE user_id = v_dep.user_id;
    v_avail_w := GREATEST(0, LEAST(
      COALESCE((public.get_user_wallet_view(v_dep.user_id) ->> 'withdrawable')::numeric, 0),
      COALESCE(v_cached, 0)));

    IF NOT v_is_agent_actor THEN
      v_avail_f := GREATEST(0, COALESCE(v_cached_f, 0));
    END IF;

    v_avail   := v_avail_w + v_avail_f;
    v_applied := round(LEAST(COALESCE(v_dep.amount, 0), v_out, v_avail), 2);
    v_from_w  := LEAST(v_applied, v_avail_w);
    v_from_f  := round(v_applied - v_from_w, 2);

    IF v_out <= 0 THEN
      v_reason := 'plan_already_cleared';
    ELSIF v_applied <= 0 THEN
      v_reason := CASE WHEN v_avail <= 0 THEN 'no_available_balance' ELSE 'nothing_to_apply' END;
    END IF;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.tenant_self_repayment_attempts (
      deposit_request_id, tenant_id, rent_request_id, agent_id,
      deposit_amount, applied_amount, outcome, reason, paid_from_phone, metadata
    ) VALUES (
      p_deposit_request_id, v_dep.user_id, v_rr, v_plan.agent_id,
      COALESCE(v_dep.amount, 0), NULL, 'refused', v_reason, v_dep.phone,
      jsonb_build_object(
        'deposit_purpose', v_purpose,
        'withdrawable', v_avail,
        'outstanding', v_out,
        'daily_repayment', v_daily,
        'paid_today', v_paid_today,
        'due_now', v_due,
        'identity_check', v_identity,
        'registered_numbers', v_reg_count
      )
    )
    ON CONFLICT (deposit_request_id) DO UPDATE
      SET outcome = 'refused', reason = v_reason, updated_at = now(),
          metadata = EXCLUDED.metadata;
    RETURN jsonb_build_object('success', false, 'reason', v_reason,
                              'identity_check', v_identity);
  END IF;

  v_surplus  := GREATEST(0, round(COALESCE(v_dep.amount, 0) - v_applied, 2));
  v_in_scope := public.is_treasury_waterfall_scope(v_rr);
  v_tracking := 'TSP-' || substr(gen_random_uuid()::text, 1, 8);

  IF v_plan.agent_id IS NOT NULL THEN
    SELECT sa.parent_agent_id INTO v_parent_id
      FROM public.agent_subagents sa
     WHERE sa.sub_agent_id = v_plan.agent_id
       AND sa.status IN ('verified', 'approved', 'accepted')
       AND sa.parent_agent_id <> sa.sub_agent_id
     LIMIT 1;
    v_whitelisted := public.is_subagent_commission_whitelisted(v_plan.agent_id);
    v_rate := public.get_agent_commission_rate(v_plan.agent_id);
  END IF;

  v_legs := jsonb_build_array(
    jsonb_build_object(
      'amount', v_applied,
      'direction', 'cash_in',
      'category', 'tenant_repayment',
      'ledger_scope', 'platform',
      'classification', 'production',
      'description', format('Tenant self-payment reduces rent receivable (%s)',
                            COALESCE(v_plan.landlord_name, 'Unknown')),
      'linked_party', v_plan.landlord_id,
      'source_table', 'agent_collections',
      'source_id', v_rr,
      'reference_id', v_tracking
    )
  );

  IF v_from_w > 0 THEN
    v_legs := v_legs || jsonb_build_array(jsonb_build_object(
      'user_id', v_dep.user_id,
      'amount', v_from_w,
      'direction', 'cash_out',
      'category', 'tenant_rent_settlement',
      'ledger_scope', 'wallet',
      'wallet_bucket', 'withdrawable',
      'recipient_type', 'user',
      'classification', 'production',
      'description', 'Tenant self-payment settled from own withdrawable balance',
      'linked_party', v_plan.landlord_id,
      'source_table', 'agent_collections',
      'source_id', v_rr,
      'reference_id', v_tracking));
  END IF;

  IF v_from_f > 0 THEN
    v_legs := v_legs || jsonb_build_array(jsonb_build_object(
      'user_id', v_dep.user_id,
      'amount', v_from_f,
      'direction', 'cash_out',
      'category', 'agent_float_used_for_rent',
      'ledger_scope', 'wallet',
      'wallet_bucket', 'float',
      'recipient_type', 'operational_wallet',
      'classification', 'production',
      'description', 'Tenant self-payment settled from own deposited balance',
      'linked_party', v_plan.landlord_id,
      'source_table', 'agent_collections',
      'source_id', v_rr,
      'reference_id', v_tracking));
  END IF;

  IF NOT v_in_scope AND v_plan.agent_id IS NOT NULL THEN
    v_comm_total := round(v_applied * (v_rate ->> 'total_rate')::numeric, 2);
    IF v_parent_id IS NOT NULL AND NOT v_whitelisted THEN
      v_comm_agent  := round(v_comm_total * (v_rate ->> 'agent_rate')::numeric
                             / NULLIF((v_rate ->> 'total_rate')::numeric, 0), 2);
      v_comm_parent := v_comm_total - v_comm_agent;
    ELSE
      v_comm_agent  := v_comm_total;
      v_comm_parent := 0;
    END IF;

    IF v_comm_total > 0 THEN
      v_legs := v_legs || jsonb_build_array(
        jsonb_build_object(
          'user_id', v_plan.agent_id, 'amount', v_comm_agent, 'direction', 'cash_in',
          'category', 'agent_commission_earned', 'ledger_scope', 'wallet',
          'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
          'classification', 'production',
          'description', 'Agent commission on tenant self-payment (legacy plan)',
          'source_table', 'agent_collections', 'source_id', v_rr, 'reference_id', v_tracking),
        jsonb_build_object(
          'amount', v_comm_total, 'direction', 'cash_out',
          'category', 'agent_commission_payable', 'ledger_scope', 'platform',
          'classification', 'production',
          'description', 'Platform commission expense on tenant self-payment (legacy plan)',
          'source_table', 'agent_collections', 'source_id', v_rr, 'reference_id', v_tracking));
      IF v_comm_parent > 0 THEN
        v_legs := v_legs || jsonb_build_array(jsonb_build_object(
          'user_id', v_parent_id, 'amount', v_comm_parent, 'direction', 'cash_in',
          'category', 'agent_commission_earned', 'ledger_scope', 'wallet',
          'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
          'classification', 'production',
          'description', 'Parent override 2% on tenant self-payment (legacy plan)',
          'source_table', 'agent_collections', 'source_id', v_rr, 'reference_id', v_tracking));
      END IF;
    END IF;
  END IF;

  v_group_a := public.create_ledger_transaction(
    v_legs, format('tenant_self_repayment:%s', p_deposit_request_id));

  INSERT INTO public.agent_collections (
    agent_id, tenant_id, rent_request_id, amount, payment_method,
    float_before, float_after, tracking_id, notes,
    collection_channel, initiated_by, deposit_request_id, performance_weight,
    expected_amount, shortfall_amount, is_partial
  ) VALUES (
    v_plan.agent_id, v_dep.user_id, v_rr, v_applied, 'in_app_wallet'::collection_payment_method,
    v_avail, GREATEST(0, v_avail - v_applied), v_tracking,
    'Tenant self-payment from own balance',
    'tenant_deposit_auto', v_dep.user_id, p_deposit_request_id, 2,
    NULLIF(v_due, 0), GREATEST(0, v_due - v_applied), v_due > v_applied
  )
  RETURNING id INTO v_collection_id;

  v_orch := public.record_rent_request_repayment_v2(
    p_tenant_id            => v_dep.user_id,
    p_amount               => v_applied,
    p_source_table         => 'agent_collections',
    p_source_id            => v_collection_id,
    p_transaction_group_id => v_group_a,
    p_rent_request_id      => v_rr
  );
  v_repayment_id := NULLIF(v_orch->>'repayment_id','')::uuid;
  v_wf           := v_orch->'waterfall';
  v_group_b      := NULLIF(v_wf->>'transaction_group_id','')::uuid;

  IF v_repayment_id IS NOT NULL THEN
    UPDATE public.repayments
       SET payment_method     = 'in_app_wallet',
           paid_by            = v_dep.user_id,
           initiated_by       = v_dep.user_id,
           deposit_request_id = p_deposit_request_id,
           external_reference = COALESCE(v_dep.transaction_id, v_tracking)
     WHERE id = v_repayment_id;
  END IF;

  UPDATE public.rent_requests
     SET last_payment_amount = v_applied,
         status = CASE WHEN status IN ('disbursed','funded','approved') AND status <> 'completed'
                       THEN 'repaying' ELSE status END,
         updated_at = now()
   WHERE id = v_rr
  RETURNING status INTO v_new_status;

  IF v_in_scope AND COALESCE(v_wf->>'status','') = 'posted' AND v_plan.agent_id IS NOT NULL THEN
    v_comm_total := GREATEST(0, COALESCE((v_wf->>'agent_commission')::numeric, 0));
    IF v_parent_id IS NOT NULL AND NOT v_whitelisted THEN
      v_comm_agent  := round(v_comm_total * (v_rate ->> 'agent_rate')::numeric
                             / NULLIF((v_rate ->> 'total_rate')::numeric, 0), 2);
      v_comm_parent := v_comm_total - v_comm_agent;
    ELSE
      v_comm_agent  := v_comm_total;
      v_comm_parent := 0;
    END IF;

    IF v_comm_total > 0 THEN
      v_legs := jsonb_build_array(
        jsonb_build_object(
          'amount', v_comm_total, 'direction', 'cash_out',
          'category', 'agent_commission_settled', 'ledger_scope', 'platform',
          'classification', 'production',
          'description', 'Agent Commission Payable settled on tenant self-payment',
          'source_table', 'agent_collections', 'source_id', v_collection_id,
          'reference_id', v_tracking),
        jsonb_build_object(
          'user_id', v_plan.agent_id, 'amount', v_comm_agent, 'direction', 'cash_in',
          'category', 'agent_commission_earned', 'ledger_scope', 'wallet',
          'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
          'classification', 'production',
          'description', CASE WHEN v_comm_parent > 0
                              THEN format('Collector agent %s on tenant self-payment', v_rate ->> 'label')
                              ELSE format('Agent %s on tenant self-payment', v_rate ->> 'label') END,
          'source_table', 'agent_collections', 'source_id', v_collection_id,
          'reference_id', v_tracking));
      IF v_comm_parent > 0 THEN
        v_legs := v_legs || jsonb_build_array(jsonb_build_object(
          'user_id', v_parent_id, 'amount', v_comm_parent, 'direction', 'cash_in',
          'category', 'agent_commission_earned', 'ledger_scope', 'wallet',
          'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
          'classification', 'production',
          'description', 'Verified parent override 2% on tenant self-payment',
          'source_table', 'agent_collections', 'source_id', v_collection_id,
          'reference_id', v_tracking));
      END IF;

      v_group_c := public.create_ledger_transaction(
        v_legs, format('tenant_self_commission:%s', p_deposit_request_id));

      -- 8% commission (2026-11-04): release the unpaid part of the fee split's
      -- commission budget (booked to agent_commission_settled) to Platform Fee.
      BEGIN
        v_release := public._release_unpaid_commission_budget(
          (v_wf->>'agent_commission_accounting')::numeric, v_comm_total,
          'agent_commission_settled', 'agent_collections', v_collection_id::text,
          v_tracking, format('commission-budget-release:tenant_self:%s', p_deposit_request_id));
      EXCEPTION WHEN OTHERS THEN
        BEGIN
          INSERT INTO public.rent_fee_collection_exceptions
            (rent_request_id, collection_id, source_table, payment_amount, reason, detail)
          VALUES (v_rr, v_collection_id, 'agent_collections', v_applied,
                  'commission_budget_release_failed', jsonb_build_object('sqlerrm', left(SQLERRM, 400)))
          ON CONFLICT (source_table, collection_id, reason) DO NOTHING;
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END;
    END IF;
  END IF;

  v_out_after := GREATEST(0, v_out - v_applied);

  -- Cover picture read from the day-by-day settlement record this payment rebuilt.
  IF v_daily > 0 THEN
    SELECT count(*), max(d.day)
      INTO v_covered_days, v_paid_up_to
      FROM (
        SELECT s.day, SUM(s.amount) AS paid
          FROM public.rent_day_settlements s
         WHERE s.rent_request_id = v_rr
         GROUP BY s.day
      ) d
     WHERE d.paid >= v_daily
       AND d.day >= v_today;

    SELECT COALESCE(SUM(s.amount), 0)
      INTO v_today_paid
      FROM public.rent_day_settlements s
     WHERE s.rent_request_id = v_rr
       AND s.day = v_today;

    v_today_gap := GREATEST(0, round(v_daily - v_today_paid, 2));
  END IF;

  v_covered_days := COALESCE(v_covered_days, 0);
  v_first_name   := COALESCE(NULLIF(split_part(COALESCE(v_dep.full_name, ''), ' ', 1), ''), 'there');

  IF v_out_after <= 0 THEN
    v_tenant_sms := format(
      E'Welile: Rent payment received, %s.\nPaid: UGX %s - your Rent Plan is now fully paid. Congratulations.%s\nRef %s. Thank you.',
      v_first_name,
      to_char(v_applied, 'FM999,999,999'),
      CASE WHEN v_surplus > 0
           THEN format(E'\nUGX %s stays in your Welile wallet.', to_char(v_surplus, 'FM999,999,999'))
           ELSE '' END,
      v_tracking);
  ELSIF v_daily > 0 AND v_today_gap > 0 THEN
    v_tenant_sms := format(
      E'Welile: Rent payment received, %s.\nPaid: UGX %s\nStill due today: UGX %s for %s.\nRent balance: UGX %s\nRef %s. Thank you.',
      v_first_name,
      to_char(v_applied, 'FM999,999,999'),
      to_char(v_today_gap, 'FM999,999,999'),
      to_char(v_today, 'DD Mon YYYY'),
      to_char(v_out_after, 'FM999,999,999'),
      v_tracking);
  ELSE
    v_tenant_sms := format(
      E'Welile: Rent payment received, %s.\nPaid: UGX %s%s\nCovers %s day%s - you are paid up to %s.\nRent balance: UGX %s\nRef %s. Thank you.',
      v_first_name,
      to_char(v_applied, 'FM999,999,999'),
      CASE WHEN v_surplus > 0 THEN ' from your wallet balance.' ELSE '' END,
      GREATEST(1, v_covered_days),
      CASE WHEN GREATEST(1, v_covered_days) = 1 THEN '' ELSE 's' END,
      to_char(COALESCE(v_paid_up_to, v_today), 'DD Mon YYYY'),
      to_char(v_out_after, 'FM999,999,999'),
      v_tracking);
  END IF;

  INSERT INTO public.tenant_self_repayment_notices (
    deposit_request_id, recipient_role, recipient_user_id, phone, sms_text
  ) VALUES (
    p_deposit_request_id, 'tenant', v_dep.user_id, v_dep.phone, v_tenant_sms
  )
  ON CONFLICT (deposit_request_id, recipient_role) DO NOTHING;

  IF v_plan.agent_id IS NOT NULL THEN
    SELECT p.phone, p.full_name INTO v_agent FROM public.profiles p WHERE p.id = v_plan.agent_id;

    IF v_daily > 0 AND v_today_gap > 0 AND v_out_after > 0 THEN
      v_agent_sms := format(
        E'Welile: %s part-paid their rent directly.\nReceived: UGX %s of UGX %s for today.\nStill to collect today: UGX %s.\nYour commission: UGX %s - already in your withdrawable balance.\nRent balance: UGX %s.',
        COALESCE(v_dep.full_name, 'Your tenant'),
        to_char(v_applied, 'FM999,999,999'),
        to_char(v_daily, 'FM999,999,999'),
        to_char(v_today_gap, 'FM999,999,999'),
        to_char(v_comm_agent, 'FM999,999,999'),
        to_char(v_out_after, 'FM999,999,999'));
    ELSE
      v_agent_sms := format(
        E'Welile: %s paid their rent directly.\nReceived: UGX %s (covers %s day%s, paid up to %s)\nYour commission: UGX %s - already in your withdrawable balance.\nRent balance: UGX %s.%s',
        COALESCE(v_dep.full_name, 'Your tenant'),
        to_char(v_applied, 'FM999,999,999'),
        GREATEST(1, v_covered_days),
        CASE WHEN GREATEST(1, v_covered_days) = 1 THEN '' ELSE 's' END,
        to_char(COALESCE(v_paid_up_to, v_today), 'DD Mon YYYY'),
        to_char(v_comm_agent, 'FM999,999,999'),
        to_char(v_out_after, 'FM999,999,999'),
        CASE WHEN v_out_after <= 0 THEN ' Rent Plan fully paid.'
             WHEN v_paid_up_to IS NOT NULL AND v_paid_up_to > v_today
             THEN format(' No collection needed until %s.', to_char(v_paid_up_to + 1, 'DD Mon'))
             ELSE '' END);
    END IF;

    INSERT INTO public.tenant_self_repayment_notices (
      deposit_request_id, recipient_role, recipient_user_id, phone, sms_text
    ) VALUES (
      p_deposit_request_id, 'agent', v_plan.agent_id, v_agent.phone, v_agent_sms
    )
    ON CONFLICT (deposit_request_id, recipient_role) DO NOTHING;
  END IF;

  INSERT INTO public.tenant_self_repayment_attempts (
    deposit_request_id, tenant_id, rent_request_id, agent_id,
    deposit_amount, applied_amount, surplus_amount, outcome, reason,
    paid_from_phone, transaction_group_id, metadata
  ) VALUES (
    p_deposit_request_id, v_dep.user_id, v_rr, v_plan.agent_id,
    COALESCE(v_dep.amount, 0), v_applied, v_surplus, 'settled', NULL,
    v_dep.phone, v_group_a,
    jsonb_build_object(
      'collection_id', v_collection_id,
      'repayment_id', v_repayment_id,
      'tracking_id', v_tracking,
      'identity_check', v_identity,
      'registered_numbers', v_reg_count,
      'in_treasury_scope', v_in_scope,
      'settlement_group_id', v_group_a,
      'waterfall_group_id', v_group_b,
      'commission_group_id', v_group_c,
      'waterfall', v_wf,
      'commission_total', v_comm_total,
      'commission_agent', v_comm_agent,
      'commission_parent', v_comm_parent,
      'parent_agent_id', v_parent_id,
      'other_active_plans', v_plan.other_active_plans,
      'performance_weight', 2,
      'money_source', CASE WHEN v_from_f > 0 AND v_from_w > 0 THEN 'tenant_withdrawable+deposited_float'
                           WHEN v_from_f > 0 THEN 'tenant_deposited_float'
                           ELSE 'tenant_withdrawable' END,
      'applied_from_withdrawable', v_from_w,
      'applied_from_float', v_from_f,
      'withdrawable_before', v_avail,
      'withdrawable_after', GREATEST(0, v_avail - v_applied),
      'new_status', v_new_status,
      'paid_today_before', v_paid_today,
      'due_now', v_due,
      'days_covered', v_covered_days,
      'paid_up_to', v_paid_up_to,
      'today_gap', v_today_gap,
      'outstanding_after', v_out_after
    )
  )
  ON CONFLICT (deposit_request_id) DO UPDATE
    SET outcome = 'settled', reason = NULL, applied_amount = EXCLUDED.applied_amount,
        surplus_amount = EXCLUDED.surplus_amount, metadata = EXCLUDED.metadata,
        transaction_group_id = EXCLUDED.transaction_group_id, updated_at = now();

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, description, metadata)
  VALUES (
    'payment_made', v_dep.user_id, 'rent_requests', v_rr,
    'Tenant self-payment settled from own balance',
    jsonb_build_object(
      'deposit_request_id', p_deposit_request_id,
      'channel', 'tenant_deposit_auto',
      'applied_amount', v_applied,
      'surplus_amount', v_surplus,
      'commission_total', v_comm_total,
      'agent_id', v_plan.agent_id,
      'in_treasury_scope', v_in_scope,
      'settlement_group_id', v_group_a,
      'waterfall_group_id', v_group_b,
      'commission_group_id', v_group_c,
      'days_covered', v_covered_days,
      'performance_weight', 2
    )
  );

  BEGIN
    PERFORM public.capture_trust_signal(v_dep.user_id, 'rent_payment', NULL, NULL, NULL, NULL, NULL,
      'Tenant self-payment');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'rent_request_id', v_rr,
    'applied_amount', v_applied,
    'surplus_amount', v_surplus,
    'due_now', v_due,
    'paid_today_before', v_paid_today,
    'days_covered', v_covered_days,
    'paid_up_to', v_paid_up_to,
    'today_gap', v_today_gap,
    'outstanding_after', v_out_after,
    'in_treasury_scope', v_in_scope,
    'settlement_group_id', v_group_a,
    'waterfall_group_id', v_group_b,
    'commission_group_id', v_group_c,
    'waterfall', v_wf,
    'commission_total', v_comm_total,
    'commission_agent', v_comm_agent,
    'commission_parent', v_comm_parent,
    'identity_check', v_identity,
    'collection_id', v_collection_id,
    'repayment_id', v_repayment_id,
    'tracking_id', v_tracking,
    'new_status', v_new_status,
    'money_source', CASE WHEN v_from_f > 0 AND v_from_w > 0 THEN 'tenant_withdrawable+deposited_float'
                         WHEN v_from_f > 0 THEN 'tenant_deposited_float'
                         ELSE 'tenant_withdrawable' END,
    'performance_weight', 2
  );
END;
$function$
;


-- ---------------------------------------------------------------------------
-- credit_agent_rent_commission (repayment engine) (live production text + 8% edits)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.credit_agent_rent_commission(p_rent_request_id uuid, p_repayment_amount numeric, p_tenant_id uuid, p_event_reference_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_agent_id  uuid;
  v_manager_agent_id uuid;
  v_recruiter_id     uuid;
  v_total_commission numeric;
  v_source_amount    numeric;
  v_manager_amount   numeric;
  v_recruiter_amount numeric;
  v_same_agent       boolean;
  v_credited         numeric := 0;
  v_result           jsonb := '[]'::jsonb;
  v_txn_group        uuid;
  v_idem_key         text;
BEGIN
  v_idem_key         := COALESCE(p_event_reference_id, p_rent_request_id::text);
  v_total_commission := round(p_repayment_amount * 0.08);  -- 8% since 2026-11-04 (was 10%)

  SELECT agent_id, assigned_agent_id
    INTO v_source_agent_id, v_manager_agent_id
    FROM rent_requests WHERE id = p_rent_request_id;

  IF v_manager_agent_id IS NULL THEN v_manager_agent_id := v_source_agent_id; END IF;
  IF v_source_agent_id IS NULL AND v_manager_agent_id IS NULL THEN
    RETURN jsonb_build_object('status','no_agents','total_commission',0,'credited_commission',0);
  END IF;

  v_same_agent := (v_source_agent_id = v_manager_agent_id);

  -- Only an ACCEPTED sub-agent link earns the recruiter an override. Pending,
  -- expired, rejected or released links pay nothing to the recruiter.
  SELECT parent_agent_id INTO v_recruiter_id
    FROM agent_subagents
   WHERE sub_agent_id = v_manager_agent_id
     AND status = 'verified'
   ORDER BY created_at ASC
   LIMIT 1;

  IF v_same_agent THEN
    IF v_recruiter_id IS NOT NULL AND v_recruiter_id <> v_source_agent_id THEN
      v_manager_amount   := round(p_repayment_amount * 0.06);
      v_recruiter_amount := v_total_commission - v_manager_amount;
      v_source_amount    := 0;
    ELSE
      v_manager_amount   := v_total_commission;
      v_recruiter_amount := 0;
      v_source_amount    := 0;
    END IF;
  ELSE
    v_source_amount := round(p_repayment_amount * 0.02);
    IF v_recruiter_id IS NOT NULL AND v_recruiter_id <> v_source_agent_id AND v_recruiter_id <> v_manager_agent_id THEN
      v_recruiter_amount := round(p_repayment_amount * 0.02);
      v_manager_amount   := v_total_commission - v_source_amount - v_recruiter_amount;
    ELSE
      v_recruiter_amount := 0;
      v_manager_amount   := v_total_commission - v_source_amount;
    END IF;
  END IF;

  IF v_source_amount > 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM commission_accrual_ledger
       WHERE source_id = v_idem_key AND agent_id = v_source_agent_id
         AND commission_role = 'source_agent' AND event_type = 'repayment'
    ) THEN
      v_txn_group := gen_random_uuid();
      PERFORM public.create_ledger_transaction(
        'agent_rent_commission_source',
        jsonb_build_array(
          jsonb_build_object(
            'user_id', v_source_agent_id, 'amount', v_source_amount,
            'direction', 'cash_in', 'category', 'agent_commission_earned',
            'ledger_scope', 'wallet', 'classification','production',
            'description', 'Onboarding commission (2%) on repayment',
            'source_table', 'commission_engine', 'source_id', p_rent_request_id::text,
            'reference_id', v_txn_group::text, 'recipient_type', 'user'
          ),
          jsonb_build_object(
            'user_id', v_source_agent_id, 'amount', v_source_amount,
            'direction', 'cash_out', 'category', 'marketing_expense',
            'ledger_scope', 'platform', 'classification','production',
            'description', 'Marketing expense: Source agent 2% commission',
            'source_table', 'commission_engine', 'source_id', p_rent_request_id::text,
            'reference_id', v_txn_group::text
          )
        )
      );
      INSERT INTO commission_accrual_ledger (agent_id, tenant_id, amount, percentage, event_type, commission_role, source_type, source_id, rent_request_id, repayment_amount, status, description)
      VALUES (v_source_agent_id, p_tenant_id, v_source_amount, 2, 'repayment', 'source_agent', 'repayment', v_idem_key, p_rent_request_id, p_repayment_amount, 'earned', 'Source agent 2% commission');
      v_credited := v_credited + v_source_amount;
      v_result := v_result || jsonb_build_object('source_agent', v_source_agent_id, 'source_amount', v_source_amount);
    END IF;
  END IF;

  IF v_manager_amount > 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM commission_accrual_ledger
       WHERE source_id = v_idem_key AND agent_id = v_manager_agent_id
         AND commission_role = 'tenant_manager' AND event_type = 'repayment'
    ) THEN
      v_txn_group := gen_random_uuid();
      PERFORM public.create_ledger_transaction(
        'agent_rent_commission_manager',
        jsonb_build_array(
          jsonb_build_object(
            'user_id', v_manager_agent_id, 'amount', v_manager_amount,
            'direction', 'cash_in', 'category', 'agent_commission_earned',
            'ledger_scope', 'wallet', 'classification','production',
            'description', 'Manager commission on repayment',
            'source_table', 'commission_engine', 'source_id', p_rent_request_id::text,
            'reference_id', v_txn_group::text, 'recipient_type', 'user'
          ),
          jsonb_build_object(
            'user_id', v_manager_agent_id, 'amount', v_manager_amount,
            'direction', 'cash_out', 'category', 'marketing_expense',
            'ledger_scope', 'platform', 'classification','production',
            'description', 'Marketing expense: Manager agent commission',
            'source_table', 'commission_engine', 'source_id', p_rent_request_id::text,
            'reference_id', v_txn_group::text
          )
        )
      );
      INSERT INTO commission_accrual_ledger (agent_id, tenant_id, amount, percentage, event_type, commission_role, source_type, source_id, rent_request_id, repayment_amount, status, description)
      VALUES (v_manager_agent_id, p_tenant_id, v_manager_amount, round(v_manager_amount * 100 / NULLIF(p_repayment_amount, 0), 2), 'repayment', 'tenant_manager', 'repayment', v_idem_key, p_rent_request_id, p_repayment_amount, 'earned', 'Manager agent commission');
      v_credited := v_credited + v_manager_amount;
      v_result := v_result || jsonb_build_object('manager_agent', v_manager_agent_id, 'manager_amount', v_manager_amount);
    END IF;
  END IF;

  IF v_recruiter_amount > 0 AND v_recruiter_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM commission_accrual_ledger
       WHERE source_id = v_idem_key AND agent_id = v_recruiter_id
         AND commission_role = 'recruiter' AND event_type = 'repayment'
    ) THEN
      v_txn_group := gen_random_uuid();
      PERFORM public.create_ledger_transaction(
        'agent_rent_commission_recruiter',
        jsonb_build_array(
          jsonb_build_object(
            'user_id', v_recruiter_id, 'amount', v_recruiter_amount,
            'direction', 'cash_in', 'category', 'agent_commission_earned',
            'ledger_scope', 'wallet', 'classification','production',
            'description', 'Recruiter commission on repayment',
            'source_table', 'commission_engine', 'source_id', p_rent_request_id::text,
            'reference_id', v_txn_group::text, 'recipient_type', 'user'
          ),
          jsonb_build_object(
            'user_id', v_recruiter_id, 'amount', v_recruiter_amount,
            'direction', 'cash_out', 'category', 'marketing_expense',
            'ledger_scope', 'platform', 'classification','production',
            'description', 'Marketing expense: Recruiter agent commission',
            'source_table', 'commission_engine', 'source_id', p_rent_request_id::text,
            'reference_id', v_txn_group::text
          )
        )
      );
      INSERT INTO commission_accrual_ledger (agent_id, tenant_id, amount, percentage, event_type, commission_role, source_type, source_id, rent_request_id, repayment_amount, status, description)
      VALUES (v_recruiter_id, p_tenant_id, v_recruiter_amount, 2, 'repayment', 'recruiter', 'repayment', v_idem_key, p_rent_request_id, p_repayment_amount, 'earned', 'Recruiter agent commission');
      v_credited := v_credited + v_recruiter_amount;
      v_result := v_result || jsonb_build_object('recruiter', v_recruiter_id, 'recruiter_amount', v_recruiter_amount);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_credited > 0 THEN 'credited' ELSE 'already_credited' END,
    'total_commission', v_total_commission,
    'credited_commission', v_credited,
    'splits', v_result
  );
END;
$function$
;


-- ---------------------------------------------------------------------------
-- get_subagent_recruiter_splits (live production text + 8% edits)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_subagent_recruiter_splits(p_sub_agent_id uuid)
 RETURNS TABLE(trace_id uuid, created_at timestamp with time zone, tracking_id text, tenant_name text, amount numeric, total_commission numeric, subagent_share numeric, recruiter_override numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_parent uuid := auth.uid();
BEGIN
  -- Only the recruiting (parent) agent of this sub-agent may read the splits.
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_subagents sa
    WHERE sa.sub_agent_id = p_sub_agent_id
      AND sa.parent_agent_id = v_parent
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    t.id,
    t.created_at,
    t.tracking_id,
    COALESCE(p.full_name, 'Tenant') AS tenant_name,
    t.amount,
    COALESCE(t.commission_earned, 0) + COALESCE((
      SELECT SUM((leg->>'amount')::numeric)
      FROM jsonb_array_elements(t.legs) AS leg
      WHERE leg->>'category' = 'agent_commission_earned'
        AND leg->>'user_id' = v_parent::text
    ), 0) AS total_commission,
    t.commission_earned AS subagent_share,
    COALESCE((
      SELECT SUM((leg->>'amount')::numeric)
      FROM jsonb_array_elements(t.legs) AS leg
      WHERE leg->>'category' = 'agent_commission_earned'
        AND leg->>'user_id' = v_parent::text
    ), 0) AS recruiter_override
  FROM public.agent_allocation_traces t
  LEFT JOIN public.profiles p ON p.id = t.tenant_id
  WHERE t.agent_id = p_sub_agent_id
  ORDER BY t.created_at DESC;
END;
$function$
;


-- ---------------------------------------------------------------------------
-- agent_ops_list_subagent_commission_whitelist (live production text + 8% edits)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_ops_list_subagent_commission_whitelist(p_search text DEFAULT NULL::text)
 RETURNS TABLE(sub_agent_id uuid, sub_agent_name text, sub_agent_phone text, parent_agent_id uuid, parent_agent_name text, link_status text, whitelisted boolean, reason text, updated_at timestamp with time zone, collections_30d numeric, commission_30d numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.agent_ops_whitelist_admin(v_uid) THEN
    RAISE EXCEPTION 'Agent Ops role required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    sa.sub_agent_id,
    COALESCE(sp.full_name, 'Sub-agent'),
    sp.phone,
    sa.parent_agent_id,
    COALESCE(pp.full_name, 'Parent agent'),
    sa.status,
    COALESCE(w.whitelisted, false),
    w.reason,
    w.updated_at,
    COALESCE(c.total_amount, 0),
    COALESCE(c.total_commission, 0)
  FROM public.agent_subagents sa
  LEFT JOIN public.profiles sp ON sp.id = sa.sub_agent_id
  LEFT JOIN public.profiles pp ON pp.id = sa.parent_agent_id
  LEFT JOIN public.agent_subagent_commission_whitelist w ON w.sub_agent_id = sa.sub_agent_id
  LEFT JOIN LATERAL (
    SELECT SUM(ac.amount) AS total_amount, round(SUM(ac.amount) * (public.get_agent_commission_rate(NULL) ->> 'total_rate')::numeric, 2) AS total_commission
    FROM (SELECT * FROM public.agent_collections WHERE reversed_at IS NULL) ac
    WHERE ac.agent_id = sa.sub_agent_id
      AND ac.created_at >= now() - interval '30 days'
  ) c ON true
  WHERE sa.status IN ('verified','approved','accepted','active')
    AND sa.parent_agent_id IS DISTINCT FROM sa.sub_agent_id
    AND (
      p_search IS NULL OR btrim(p_search) = ''
      OR sp.full_name ILIKE '%' || btrim(p_search) || '%'
      OR sp.phone ILIKE '%' || btrim(p_search) || '%'
      OR pp.full_name ILIKE '%' || btrim(p_search) || '%'
    )
  ORDER BY COALESCE(w.whitelisted, false) DESC, COALESCE(c.total_amount, 0) DESC
  LIMIT 500;
END;
$function$
;


-- ---------------------------------------------------------------------------
-- agent_performance_home_basis_range (live production text + 8% edits)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_performance_home_basis_range(p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_start timestamptz;
  v_end timestamptz;
  v_d1 date;
  v_d2 date;
  v_today date;
  v_asof date;
  v_days int;
  v_bill_days int;
  v_rows jsonb;
  v_totals record;
BEGIN
  IF NOT (
    public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'cto') OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'coo')
  ) THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF p_start IS NULL OR p_end IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;

  v_start := (date_trunc('day', (p_start AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala');
  v_end := (date_trunc('day', (p_end AT TIME ZONE 'Africa/Kampala')) AT TIME ZONE 'Africa/Kampala') + interval '1 day';
  IF v_end <= v_start THEN v_end := v_start + interval '1 day'; END IF;

  v_today := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_d1 := (v_start AT TIME ZONE 'Africa/Kampala')::date;
  v_d2 := ((v_end - interval '1 microsecond') AT TIME ZONE 'Africa/Kampala')::date;
  v_asof := LEAST(v_d2, v_today);
  v_days := GREATEST(1, round(extract(epoch FROM (v_end - v_start)) / 86400)::int);
  v_bill_days := CASE WHEN v_asof >= v_d1 THEN GREATEST(1, (v_asof - v_d1 + 1)) ELSE 1 END;

  WITH bill_by_plan AS (
    SELECT p.agent_id, p.rent_request_id, p.tenant_id, sum(p.expected_ugx)::numeric AS expected
    FROM public.agent_expected_day_plans p
    WHERE p.day BETWEEN v_d1 AND v_asof
      AND p.agent_id IS NOT NULL
    GROUP BY p.agent_id, p.rent_request_id, p.tenant_id
  ), cash_by_plan AS (
    SELECT ac.rent_request_id,
           sum(ac.amount)::numeric AS paid,
           count(*)::int AS payments,
           max(ac.created_at) AS last_at
    FROM public.agent_collections ac
    WHERE ac.created_at >= v_start
      AND ac.created_at < v_end
      AND ac.amount > 0
      AND ac.reversed_at IS NULL
      AND ac.rent_request_id IS NOT NULL
    GROUP BY ac.rent_request_id
  ), scheduled_plan AS (
    SELECT b.agent_id,
           b.tenant_id,
           b.expected,
           LEAST(COALESCE(c.paid, 0), b.expected)::numeric AS collected,
           COALESCE(c.payments, 0)::int AS payments,
           c.last_at
    FROM bill_by_plan b
    LEFT JOIN cash_by_plan c ON c.rent_request_id = b.rent_request_id
  ), schedule_by_agent AS (
    SELECT sp.agent_id,
           sum(sp.expected)::numeric AS expected,
           sum(sp.collected)::numeric AS collected,
           GREATEST(sum(sp.expected) - sum(sp.collected), 0)::numeric AS gap,
           count(DISTINCT sp.tenant_id)::int AS tenants_total,
           count(DISTINCT sp.tenant_id) FILTER (WHERE sp.collected > 0)::int AS tenants_paid,
           sum(sp.payments)::int AS payments,
           max(sp.last_at) AS last_collection_at
    FROM scheduled_plan sp
    GROUP BY sp.agent_id
  ), earnings_by_agent AS (
    SELECT e.agent_id,
           COALESCE(sum(e.amount) FILTER (WHERE lower(COALESCE(e.earning_type, '')) LIKE '%interest%'), 0)::numeric AS interest,
           COALESCE(sum(e.amount) FILTER (WHERE lower(COALESCE(e.earning_type, '')) LIKE '%commission%'), 0)::numeric AS commission
    FROM public.agent_earnings e
    WHERE e.created_at >= v_start
      AND e.created_at < v_end
      AND e.agent_id IS NOT NULL
    GROUP BY e.agent_id
  ), payout_by_agent AS (
    SELECT lp.agent_id,
           COALESCE(sum(lp.amount), 0)::numeric AS rent_paid_out
    FROM public.landlord_payouts lp
    WHERE COALESCE(lp.disbursed_at, lp.created_at) >= v_start
      AND COALESCE(lp.disbursed_at, lp.created_at) < v_end
      AND lp.agent_id IS NOT NULL
      AND (lower(COALESCE(lp.status, '')) IN ('disbursed', 'completed', 'paid', 'success') OR lp.disbursed_at IS NOT NULL)
    GROUP BY lp.agent_id
  ), ids AS (
    SELECT agent_id FROM schedule_by_agent
    UNION SELECT agent_id FROM earnings_by_agent
    UNION SELECT agent_id FROM payout_by_agent
  ), scored AS (
    SELECT i.agent_id,
           COALESCE(NULLIF(trim(p.full_name), ''), p.phone, 'Agent ' || left(i.agent_id::text, 6)) AS agent_name,
           COALESCE(s.tenants_paid, 0)::int AS tenants_paid,
           COALESCE(s.tenants_total, 0)::int AS tenants_total,
           COALESCE(s.expected, 0)::numeric AS expected,
           COALESCE(s.collected, 0)::numeric AS collected,
           COALESCE(s.payments, 0)::int AS payments,
           COALESCE(s.gap, 0)::numeric AS gap,
           COALESCE(e.interest, 0)::numeric AS interest,
           COALESCE(e.commission, 0)::numeric AS commission_earned,
           COALESCE(po.rent_paid_out, 0)::numeric AS rent_paid_out,
           CASE WHEN COALESCE(s.expected, 0) > 0 THEN round(COALESCE(s.collected, 0) * 100.0 / s.expected, 1) ELSE NULL END AS efficiency
    FROM ids i
    LEFT JOIN schedule_by_agent s ON s.agent_id = i.agent_id
    LEFT JOIN earnings_by_agent e ON e.agent_id = i.agent_id
    LEFT JOIN payout_by_agent po ON po.agent_id = i.agent_id
    LEFT JOIN public.profiles p ON p.id = i.agent_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'agent_id', s.agent_id,
           'agent_name', s.agent_name,
           'tenants_paid', s.tenants_paid,
           'tenants_total', s.tenants_total,
           'pct_paid', CASE WHEN s.tenants_total > 0 THEN round(s.tenants_paid * 100.0 / s.tenants_total, 1) ELSE 0 END,
           'collected', s.collected,
           'expected', s.expected,
           'payments', s.payments,
           'commission', CASE WHEN s.commission_earned > 0 THEN s.commission_earned ELSE round(s.collected * 0.08, 0) END,
           'interest', s.interest,
           'wallet_total', (CASE WHEN s.commission_earned > 0 THEN s.commission_earned ELSE round(s.collected * 0.08, 0) END) + s.interest,
           'rate', CASE WHEN s.collected > 0 THEN (((CASE WHEN s.commission_earned > 0 THEN s.commission_earned ELSE round(s.collected * 0.08, 0) END) + s.interest) * 100.0 / s.collected) ELSE 0 END,
           'daily_portfolio', CASE WHEN v_bill_days > 0 THEN round(s.expected / v_bill_days, 0) ELSE 0 END,
           'expected_period', s.expected,
           'efficiency', COALESCE(s.efficiency, 0),
           'gap', s.gap,
           'daily_collection', CASE WHEN v_bill_days > 0 THEN round(s.collected / v_bill_days, 0) ELSE 0 END,
           'daily_commission', CASE WHEN v_bill_days > 0 THEN round((CASE WHEN s.commission_earned > 0 THEN s.commission_earned ELSE round(s.collected * 0.08, 0) END) / v_bill_days, 0) ELSE 0 END,
           'rent_paid_out', s.rent_paid_out,
           'conversion_pct', CASE WHEN s.tenants_total > 0 THEN round(s.tenants_paid * 100.0 / s.tenants_total, 1) ELSE 0 END,
           'status', CASE
             WHEN COALESCE(s.efficiency, 0) >= 100 THEN 'excellent'
             WHEN COALESCE(s.efficiency, 0) >= 80 THEN 'good'
             WHEN COALESCE(s.efficiency, 0) >= 60 THEN 'moderate'
             WHEN COALESCE(s.efficiency, 0) >= 40 THEN 'low'
             ELSE 'critical' END,
           'source_breakdown', jsonb_build_object('agent_collections', s.collected, 'repayments', 0, 'merchant', 0)
         ) ORDER BY s.expected DESC, s.collected DESC, s.agent_name), '[]'::jsonb)
    INTO v_rows
  FROM scored s
  WHERE s.expected > 0 OR s.collected > 0 OR s.commission_earned > 0 OR s.interest > 0 OR s.rent_paid_out > 0;

  WITH row_values AS (
    SELECT (r->>'tenants_paid')::int AS tenants_paid,
           (r->>'tenants_total')::int AS tenants_total,
           (r->>'collected')::numeric AS collected,
           (r->>'expected_period')::numeric AS expected,
           (r->>'payments')::int AS payments,
           (r->>'commission')::numeric AS commission,
           (r->>'interest')::numeric AS interest,
           (r->>'wallet_total')::numeric AS wallet_total,
           (r->>'daily_portfolio')::numeric AS daily_portfolio,
           (r->>'gap')::numeric AS gap,
           (r->>'daily_collection')::numeric AS daily_collection,
           (r->>'daily_commission')::numeric AS daily_commission,
           (r->>'rent_paid_out')::numeric AS rent_paid_out
    FROM jsonb_array_elements(v_rows) r
  )
  SELECT COALESCE(sum(collected), 0)::numeric AS collected,
         COALESCE(sum(expected), 0)::numeric AS expected,
         COALESCE(sum(payments), 0)::int AS payments,
         COALESCE(sum(commission), 0)::numeric AS commission,
         COALESCE(sum(interest), 0)::numeric AS interest,
         COALESCE(sum(wallet_total), 0)::numeric AS wallet_total,
         COALESCE(sum(tenants_paid), 0)::int AS tenants_paid,
         COALESCE(sum(tenants_total), 0)::int AS tenants_total,
         COALESCE(sum(daily_portfolio), 0)::numeric AS daily_portfolio,
         COALESCE(sum(gap), 0)::numeric AS gap,
         COALESCE(sum(daily_collection), 0)::numeric AS daily_collection,
         COALESCE(sum(daily_commission), 0)::numeric AS daily_commission,
         COALESCE(sum(rent_paid_out), 0)::numeric AS rent_paid_out
    INTO v_totals
  FROM row_values;

  RETURN jsonb_build_object(
    'range', jsonb_build_object('window_start', v_start, 'window_end', v_end, 'from_day', v_d1, 'to_day', v_d2, 'as_of_day', v_asof, 'days', v_days, 'bill_days', v_bill_days),
    'basis', 'tenant_ops_home_capped_schedule',
    'rows', v_rows,
    'totals', jsonb_build_object(
      'collected', v_totals.collected,
      'expected', v_totals.expected,
      'payments', v_totals.payments,
      'commission', v_totals.commission,
      'interest', v_totals.interest,
      'wallet_total', v_totals.wallet_total,
      'tenants_paid', v_totals.tenants_paid,
      'tenants_total', v_totals.tenants_total,
      'daily_portfolio', v_totals.daily_portfolio,
      'expected_period', v_totals.expected,
      'gap', v_totals.gap,
      'daily_collection', v_totals.daily_collection,
      'daily_commission', v_totals.daily_commission,
      'rent_paid_out', v_totals.rent_paid_out,
      'efficiency', CASE WHEN v_totals.expected > 0 THEN round(v_totals.collected * 100.0 / v_totals.expected, 1) ELSE 0 END
    )
  );
END;
$function$
;


-- ---------------------------------------------------------------------------
-- get_cto_controlled_plan_collections (live production text + 8% edits)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_cto_controlled_plan_collections()
 RETURNS TABLE(row_kind text, rent_request_id uuid, tenant_name text, agent_id uuid, agent_name text, funded_on date, duration_days integer, status text, given numeric, formula_due numeric, recovered numeric, collection_count integer, last_collection_on date, partner_earned numeric, platform_earned numeric, agent_commission numeric, fees_drawn numeric, principal_back numeric, expected_partner numeric, expected_agent numeric, days_overdue integer, counter_mismatch boolean, collections_sum numeric, plans_count integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  IF v_uid IS NULL OR NOT (public.has_role(v_uid, 'cto'::app_role) OR public.has_role(v_uid, 'ceo'::app_role) OR public.has_role(v_uid, 'cfo'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH plans AS (
    SELECT r.id, r.tenant_id, COALESCE(r.assigned_agent_id, r.agent_id) AS agent_id, r.status, r.rent_amount, r.duration_days, r.amount_repaid,
           (COALESCE(r.funded_at, r.disbursed_at) AT TIME ZONE 'Africa/Kampala')::date AS funded_on
      FROM public.cto_controlled_rent_plans c JOIN public.rent_requests r ON r.id = c.rent_request_id
  ), col AS (
    SELECT ac.rent_request_id, count(*)::int AS n, COALESCE(sum(ac.amount), 0) AS amt, max((ac.created_at AT TIME ZONE 'Africa/Kampala')::date) AS last_on
      FROM public.agent_collections ac
     WHERE ac.reversed_at IS NULL AND ac.rent_request_id IN (SELECT id FROM plans)
     GROUP BY ac.rent_request_id
  ), led AS (
    SELECT ac.rent_request_id,
      COALESCE(sum(CASE WHEN g.category = 'partner_returns_allocated' THEN CASE g.direction WHEN 'cash_in' THEN g.amount ELSE -g.amount END END), 0) AS partner,
      COALESCE(sum(CASE WHEN g.category = 'platform_fee_collected' THEN CASE g.direction WHEN 'cash_in' THEN g.amount ELSE -g.amount END END), 0) AS platform,
      COALESCE(sum(CASE WHEN g.category IN ('agent_commission_payable', 'agent_commission_earned') AND g.direction = 'cash_in' THEN g.amount END), 0) AS agent,
      COALESCE(sum(CASE WHEN g.category = 'treasury_fee_drawdown' THEN CASE g.direction WHEN 'cash_out' THEN g.amount ELSE -g.amount END END), 0) AS fees
      FROM public.agent_collections ac
      JOIN public.general_ledger g ON g.source_table = 'agent_collections' AND g.source_id = ac.id
     WHERE ac.reversed_at IS NULL AND ac.rent_request_id IN (SELECT id FROM plans)
     GROUP BY ac.rent_request_id
  ), rows AS (
    SELECT p.id AS rrid, p.tenant_id, p.agent_id AS agid, p.status AS st, p.funded_on AS fd, p.duration_days AS dd,
           p.rent_amount AS g_given, f.total_repayment AS due, COALESCE(p.amount_repaid, 0) AS rec,
           COALESCE(c.n, 0) AS cn, c.last_on AS lastd, COALESCE(c.amt, 0) AS csum,
           COALESCE(l.partner, 0) AS lp, COALESCE(l.platform, 0) AS lpl, COALESCE(l.agent, 0) AS la, COALESCE(l.fees, 0) AS lf
      FROM plans p
      LEFT JOIN col c ON c.rent_request_id = p.id
      LEFT JOIN led l ON l.rent_request_id = p.id
      CROSS JOIN LATERAL public.compute_rent_repayment(p.rent_amount, COALESCE(p.duration_days, 30)) f
  ), shaped AS (
    SELECT 'plan'::text AS rk, x.rrid, t.full_name AS tn, x.agid, a.full_name AS an, x.fd, COALESCE(x.dd, 0) AS dd, x.st,
           x.g_given, x.due, x.rec, x.cn, x.lastd, x.lp, x.lpl, x.la, x.lf, (x.csum - x.lf) AS pb,
           round(0.15 * x.g_given * COALESCE(x.dd, 0) / 30.0) AS ep, round(0.08 * x.due) AS ea,
           CASE WHEN x.rec < x.due AND x.fd IS NOT NULL THEN GREATEST(0, v_today - (x.fd + COALESCE(x.dd, 0))) ELSE 0 END AS od,
           (x.csum <> x.rec) AS mm, x.csum
      FROM rows x LEFT JOIN public.profiles t ON t.id = x.tenant_id LEFT JOIN public.profiles a ON a.id = x.agid
  )
  SELECT s.rk, s.rrid, s.tn, s.agid, s.an, s.fd, s.dd, s.st, s.g_given, s.due, s.rec, s.cn, s.lastd, s.lp, s.lpl, s.la, s.lf, s.pb, s.ep, s.ea, s.od, s.mm, s.csum, 1
    FROM shaped s
  UNION ALL
  SELECT 'summary', NULL::uuid, NULL, NULL::uuid, NULL, NULL::date, NULL::int, NULL, sum(s.g_given), sum(s.due), sum(s.rec), COALESCE(sum(s.cn), 0)::int, max(s.lastd),
         sum(s.lp), sum(s.lpl), sum(s.la), sum(s.lf), sum(s.pb), sum(s.ep), sum(s.ea), COALESCE(max(s.od), 0)::int, COALESCE(bool_or(s.mm), false), sum(s.csum), count(*)::int
    FROM shaped s
  ORDER BY 1 DESC, 21 DESC NULLS LAST, 11 ASC;
END;
$function$
;
