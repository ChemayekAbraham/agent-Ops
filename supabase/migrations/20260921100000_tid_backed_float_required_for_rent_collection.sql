-- Hard rule (Josh, 2026-09-21): only float traceable to a real, gmail-matched
-- deposit TID (or a self-service move of the agent's own commission-sourced
-- withdrawable balance into float) may be used to allocate/mark a tenant's
-- rent payment as collected. Applies ONLY to the tenant rent-collection flow
-- (agent_allocate_tenant_payment_internal) — merchant/cashout agent float is
-- a structurally separate subsystem, untouched here.
--
-- Rollout, exactly as directed: existing wallet float balances are NOT
-- clawed back or reversed — "let it be on the wallet." The new gate applies
-- only to allocations attempted at or after 2026-09-22 00:00 EAT. The
-- tid-backed counter itself is seeded now from the FULL historical trace
-- (every TID-backed credit vs every draw, in chronological order, floored at
-- zero — the same reflected-random-walk accounting used to answer "how much
-- of the image's collections had TIDs"), so an agent who is genuinely
-- carrying real backed float (e.g. David Kanyesigye) starts with proper
-- credit for it rather than being reset to zero alongside everyone else.

CREATE TABLE IF NOT EXISTS public.agent_tid_backed_float (
  agent_id uuid PRIMARY KEY REFERENCES public.profiles(id),
  balance numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.credit_agent_tid_backed_float(p_agent_id uuid, p_delta numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_agent_id IS NULL OR p_delta = 0 THEN
    RETURN;
  END IF;
  INSERT INTO public.agent_tid_backed_float (agent_id, balance, updated_at)
  VALUES (p_agent_id, GREATEST(0, p_delta), now())
  ON CONFLICT (agent_id) DO UPDATE
    SET balance = GREATEST(0, public.agent_tid_backed_float.balance + p_delta),
        updated_at = now();
END;
$function$;

-- Seed: one-time backfill of every agent's TRUE clamped TID-backed balance,
-- computed from their full history up to now. Uses the reflected-random-walk
-- formula (pool_k = S_k - running_min(S_0..S_k)) so an old deficit doesn't
-- permanently suppress capacity a later real deposit actually restored.
WITH deposit_events AS (
  SELECT gl.user_id AS agent_id, gl.created_at, gl.amount AS delta, gl.id AS ev_id
    FROM public.general_ledger gl
    JOIN public.deposit_requests dr ON dr.id = gl.source_id AND gl.source_table = 'deposit_requests'
    JOIN public.gmail_transactions gt ON gt.transaction_id = dr.transaction_id
   WHERE gl.category = 'agent_float_deposit' AND gl.direction = 'cash_in' AND gl.ledger_scope = 'wallet'
  UNION ALL
  SELECT gl.user_id, gl.created_at, -gl.amount, gl.id
    FROM public.general_ledger gl
    JOIN public.deposit_requests dr ON dr.id = gl.source_id AND gl.source_table = 'deposit_requests'
   WHERE gl.category = 'agent_float_deposit' AND gl.direction = 'cash_out' AND gl.ledger_scope = 'wallet'
  UNION ALL
  SELECT gl.user_id, gl.created_at, gl.amount, gl.id
    FROM public.general_ledger gl
   WHERE gl.category = 'bucket_reclass_in' AND gl.direction = 'cash_in' AND gl.ledger_scope = 'wallet'
     AND gl.source_table = 'agent_withdrawable_to_float'
),
draw_events AS (
  SELECT ac.agent_id, ac.created_at, -ac.amount AS delta, ac.id AS ev_id
    FROM public.agent_collections ac
   WHERE ac.reversed_at IS NULL OR ac.notes ILIKE '%VOID by%'
),
all_events AS (
  SELECT agent_id, created_at, delta, ev_id::text AS ev_id FROM deposit_events
  UNION ALL
  SELECT agent_id, created_at, delta, ev_id::text FROM draw_events
),
s AS (
  SELECT *, SUM(delta) OVER (PARTITION BY agent_id ORDER BY created_at, ev_id
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS s_k
    FROM all_events
),
m AS (
  SELECT *, MIN(s_k) OVER (PARTITION BY agent_id ORDER BY created_at, ev_id
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_min_incl
    FROM s
),
final_per_agent AS (
  SELECT DISTINCT ON (agent_id) agent_id, s_k - LEAST(0, running_min_incl) AS pool_final
    FROM m
   ORDER BY agent_id, created_at DESC, ev_id DESC
)
INSERT INTO public.agent_tid_backed_float (agent_id, balance, updated_at)
SELECT agent_id, GREATEST(0, pool_final), now()
  FROM final_per_agent
ON CONFLICT (agent_id) DO UPDATE
  SET balance = EXCLUDED.balance, updated_at = now();

-- Trigger: keep the tid-backed counter current for every future qualifying
-- credit. Draws are NOT decremented here — agent_allocate_tenant_payment_internal
-- does that explicitly, atomically, in the same statement as its own check.
CREATE OR REPLACE FUNCTION public.tg_credit_tid_backed_float()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.ledger_scope <> 'wallet' OR NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.category = 'agent_float_deposit' AND NEW.source_table = 'deposit_requests' THEN
    IF NEW.direction = 'cash_in' AND EXISTS (
      SELECT 1 FROM public.deposit_requests dr
        JOIN public.gmail_transactions gt ON gt.transaction_id = dr.transaction_id
       WHERE dr.id = NEW.source_id
    ) THEN
      PERFORM public.credit_agent_tid_backed_float(NEW.user_id, NEW.amount);
    ELSIF NEW.direction = 'cash_out' THEN
      -- A reversed deposit: claw the credit back out of the tid-backed pool too.
      PERFORM public.credit_agent_tid_backed_float(NEW.user_id, -NEW.amount);
    END IF;
  ELSIF NEW.category = 'bucket_reclass_in' AND NEW.direction = 'cash_in'
        AND NEW.source_table = 'agent_withdrawable_to_float' THEN
    -- Agent moving their own (commission-sourced) withdrawable balance into
    -- float — a legitimate channel per the rule ("deposits, commissions").
    PERFORM public.credit_agent_tid_backed_float(NEW.user_id, NEW.amount);
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_credit_tid_backed_float ON public.general_ledger;
CREATE TRIGGER trg_credit_tid_backed_float
  AFTER INSERT ON public.general_ledger
  FOR EACH ROW EXECUTE FUNCTION public.tg_credit_tid_backed_float();

-- The actual gate: agent_allocate_tenant_payment_internal now also requires
-- TID-backed float, enforced only for allocations at/after 2026-09-22 00:00 EAT.
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
  v_fee jsonb := jsonb_build_object('status','not_attempted');
  v_treasury jsonb := jsonb_build_object('status','not_attempted');
  v_tid_backed_balance numeric;
  v_tid_gate_effective timestamptz := '2026-09-22 00:00:00+03'::timestamptz;
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

  -- Hard rule, effective 2026-09-22 00:00 EAT: only TID-backed float may be
  -- used to allocate a tenant payment. Historical (pre-cutover) balances are
  -- left alone; this only gates what happens from the cutover forward.
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

  -- Debit the tid-backed pool in step with the real float draw, unconditionally
  -- (keeps the balance accurate through the cutover, not just after it).
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
