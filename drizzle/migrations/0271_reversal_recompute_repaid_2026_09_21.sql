CREATE OR REPLACE FUNCTION public.agent_reverse_tenant_allocation(p_collection_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_collection record;
  v_txn_group uuid := gen_random_uuid();
  v_reversal_tracking text;
  v_commission numeric;
  v_rent_request record;
  v_fwd_float_dir text;
  v_rev_float_dir text;
  v_rev_disc_cat  text;
  v_rev_disc_dir  text;
  v_unreversed numeric;
  v_new_repaid numeric;
  v_new_status text;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Please provide a reason (at least 5 characters)');
  END IF;

  SELECT * INTO v_collection
  FROM public.agent_collections
  WHERE id = p_collection_id;

  IF v_collection.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Allocation not found');
  END IF;

  IF v_collection.agent_id <> v_caller THEN
    RETURN jsonb_build_object('success', false, 'error', 'You can only reverse your own allocations');
  END IF;

  IF COALESCE(v_collection.notes, '') NOT ILIKE '%float allocation%' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only float allocations can be reversed');
  END IF;

  IF v_collection.reversed_at IS NOT NULL OR COALESCE(v_collection.notes, '') ILIKE '%[REVERSED%' THEN
    RETURN jsonb_build_object('success', false, 'error', 'This allocation was already reversed');
  END IF;

  SELECT * INTO v_rent_request
  FROM public.rent_requests
  WHERE id = (
    SELECT source_id FROM public.general_ledger
    WHERE source_table = 'agent_collections'
      AND user_id = v_collection.agent_id
      AND category = 'agent_float_used_for_rent'
      AND description LIKE '%' || v_collection.tracking_id || '%'
    LIMIT 1
  );

  IF v_rent_request.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Original rent request not found');
  END IF;

  -- Mirror whichever shape the forward collection actually used.
  SELECT gl.direction INTO v_fwd_float_dir
    FROM public.general_ledger gl
   WHERE gl.source_table = 'agent_collections'
     AND gl.source_id = v_rent_request.id
     AND gl.user_id = v_collection.agent_id
     AND gl.category = 'agent_float_used_for_rent'
     AND gl.ledger_scope = 'wallet'
   ORDER BY gl.created_at DESC
   LIMIT 1;

  IF v_fwd_float_dir = 'cash_in' THEN
    v_rev_float_dir := 'cash_out';
    v_rev_disc_cat  := 'tenant_repayment_collected';
    v_rev_disc_dir  := 'cash_in';
  ELSE
    v_rev_float_dir := 'cash_in';
    v_rev_disc_cat  := 'tenant_repayment';
    v_rev_disc_dir  := 'cash_out';
  END IF;

  v_reversal_tracking := 'REV-' || v_collection.tracking_id;
  v_commission := ROUND(v_collection.amount * 0.10);

  PERFORM set_config('ledger.authorized', 'true', true);

  INSERT INTO public.general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
  VALUES (v_collection.agent_id, v_collection.amount, v_rev_float_dir, 'agent_float_used_for_rent', 'agent_collections', v_rent_request.id,
    format('Reversal of float allocation — %s. Reason: %s', v_reversal_tracking, p_reason), 'wallet', v_txn_group);

  INSERT INTO public.general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
  VALUES (v_collection.agent_id, v_collection.amount, v_rev_disc_dir, v_rev_disc_cat, 'agent_collections', v_rent_request.id,
    format('Reversal of tenant repayment — %s', v_reversal_tracking), 'platform', v_txn_group);

  IF v_commission > 0 THEN
    INSERT INTO public.general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
    VALUES (v_collection.agent_id, v_commission, 'cash_out', 'agent_commission_earned', 'agent_collections', v_rent_request.id,
      format('Commission reversal for allocation — %s', v_reversal_tracking), 'wallet', v_txn_group);

    INSERT INTO public.general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
    VALUES (v_collection.agent_id, v_commission, 'cash_in', 'agent_commission_earned', 'agent_collections', v_rent_request.id,
      format('Reversed commission expense — %s', v_reversal_tracking), 'platform', v_txn_group);
  END IF;

  -- Mark the collection reversed FIRST so the recompute below excludes it.
  UPDATE public.agent_collections
  SET reversed_at = COALESCE(reversed_at, now()),
      notes = COALESCE(notes, '') || ' [REVERSED: ' || p_reason || ']'
  WHERE id = p_collection_id;

  -- Recompute the recorded total from the collections that survive, instead of
  -- blindly subtracting from a total that may have been capped at the plan
  -- ceiling (which produced phantom balances for overpaying tenants).
  SELECT COALESCE(SUM(c.amount), 0) INTO v_unreversed
  FROM public.agent_collections c
  WHERE c.rent_request_id = v_rent_request.id
    AND c.reversed_at IS NULL;

  -- Never drop below what the blind subtraction would have given: that protects
  -- repayments recorded through non-agent channels (tenant wallet, deposits).
  v_new_repaid := GREATEST(
    0,
    v_unreversed,
    COALESCE(v_rent_request.amount_repaid, 0) - v_collection.amount
  );
  v_new_repaid := LEAST(v_new_repaid, COALESCE(v_rent_request.total_repayment, v_new_repaid));

  IF v_new_repaid >= COALESCE(v_rent_request.total_repayment, 0) THEN
    v_new_status := 'completed';
  ELSIF v_rent_request.status = 'completed' THEN
    v_new_status := 'repaying';
  ELSE
    v_new_status := v_rent_request.status;
  END IF;

  UPDATE public.rent_requests
  SET amount_repaid = v_new_repaid,
      status = v_new_status,
      updated_at = NOW()
  WHERE id = v_rent_request.id;

  INSERT INTO public.repayments (tenant_id, rent_request_id, amount, created_at)
  VALUES (v_collection.tenant_id, v_rent_request.id, -v_collection.amount, NOW());

  RETURN jsonb_build_object(
    'success', true,
    'reversal_tracking_id', v_reversal_tracking,
    'amount_returned', v_collection.amount,
    'commission_clawed_back', v_commission,
    'rent_request_id', v_rent_request.id,
    'recomputed_amount_repaid', v_new_repaid,
    'rent_request_status', v_new_status
  );
END;
$function$;