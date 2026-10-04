-- Admin-initiated reversal for agent-reported cash collections that carry no
-- independent evidence (no momo_transaction_id, no linked deposit_request /
-- gmail_transactions row). Distinct from the existing self-service
-- agent_reverse_tenant_allocation, which only lets an agent reverse their OWN
-- "float allocation" and can't be used by staff on someone else's records.
--
-- Reverses every general_ledger leg posted for the collection (matched via
-- source_table='agent_collections' + source_id=rent_request_id +
-- created_at=collection.created_at — all legs of one collection share that
-- exact microsecond timestamp), decrements rent_requests.amount_repaid,
-- inserts a negative repayments row, and marks agent_collections.reversed_at.
--
-- Commission legs being clawed back can push an agent's withdrawable wallet
-- negative when they've already cashed out the commission earned on the
-- voided collection — that's expected here (the clawback is real; the agent
-- now owes it back) so the reversal legs are tagged
-- classification='admin_correction' + solvency_bypass_reason='other_with_note'
-- to pass enforce_no_negative_wallet_ledger().
CREATE OR REPLACE FUNCTION public.admin_void_unverified_collection(
  p_collection_id uuid,
  p_actor_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_collection record;
  v_txn_group uuid := gen_random_uuid();
  v_leg record;
  v_new_direction text;
  v_leg_count int := 0;
  v_desc text;
BEGIN
  IF p_actor_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'actor_required');
  END IF;

  IF NOT (
    public.is_ops_role(p_actor_id)
    OR public.has_role(p_actor_id, 'manager')
    OR public.has_role(p_actor_id, 'cfo')
    OR public.has_role(p_actor_id, 'ceo')
    OR public.has_role(p_actor_id, 'coo')
    OR public.has_role(p_actor_id, 'cto')
    OR public.has_role(p_actor_id, 'super_admin')
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
    RETURN jsonb_build_object('success', false, 'error', 'reason_required');
  END IF;

  SELECT * INTO v_collection FROM public.agent_collections WHERE id = p_collection_id FOR UPDATE;

  IF v_collection.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'collection_not_found');
  END IF;

  IF v_collection.reversed_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_reversed', 'collection_id', p_collection_id);
  END IF;

  PERFORM set_config('ledger.authorized', 'true', true);

  FOR v_leg IN
    SELECT * FROM public.general_ledger
    WHERE source_table = 'agent_collections'
      AND source_id = v_collection.rent_request_id
      AND created_at = v_collection.created_at
  LOOP
    v_new_direction := CASE v_leg.direction WHEN 'cash_in' THEN 'cash_out' WHEN 'cash_out' THEN 'cash_in' ELSE v_leg.direction END;
    v_desc := format(
      'VOID (no deposit/email evidence for this agent_float cash collection) — reversal of ledger leg %s. Reason: %s',
      v_leg.id, p_reason
    );

    INSERT INTO public.general_ledger (
      user_id, amount, direction, category, source_table, source_id, description,
      ledger_scope, transaction_group_id, wallet_bucket, rent_request_id, idempotency_key,
      classification, solvency_bypass_reason
    ) VALUES (
      v_leg.user_id, v_leg.amount, v_new_direction, v_leg.category, 'agent_collections', v_collection.rent_request_id,
      v_desc,
      v_leg.ledger_scope, v_txn_group, v_leg.wallet_bucket, v_leg.rent_request_id,
      format('void_unverified_collection:%s:%s', v_collection.id, v_leg.id),
      'admin_correction', 'other_with_note'::public.solvency_bypass_reason
    );
    v_leg_count := v_leg_count + 1;
  END LOOP;

  IF v_leg_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_ledger_legs_found', 'collection_id', p_collection_id);
  END IF;

  UPDATE public.rent_requests
  SET amount_repaid = GREATEST(0, amount_repaid - v_collection.amount),
      status = CASE WHEN status = 'completed' THEN 'repaying' ELSE status END,
      updated_at = now()
  WHERE id = v_collection.rent_request_id;

  INSERT INTO public.repayments (tenant_id, rent_request_id, amount, created_at)
  VALUES (v_collection.tenant_id, v_collection.rent_request_id, -v_collection.amount, now());

  UPDATE public.agent_collections
  SET reversed_at = now(),
      notes = COALESCE(notes, '') || format(' [VOID by %s: %s]', p_actor_id, p_reason)
  WHERE id = p_collection_id;

  RETURN jsonb_build_object(
    'success', true,
    'collection_id', p_collection_id,
    'amount_voided', v_collection.amount,
    'legs_reversed', v_leg_count,
    'transaction_group_id', v_txn_group
  );
END;
$function$;

-- Data fix already applied live on 2026-09-21 against production: 46 collections
-- (8 agents, 2026-09-14 Africa/Kampala day, collection_channel='agent_float',
-- momo_transaction_id IS NULL, deposit_request_id IS NULL — UGX 1,260,000 total)
-- were voided via this function per CEO directive. See docs/HANDOVER/93-*.md.
-- Not re-run here: the function is idempotent per collection (reversed_at guard),
-- so replaying it against already-voided rows is a harmless no-op.
