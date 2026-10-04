
CREATE OR REPLACE FUNCTION public.agent_reverse_tenant_allocation(
  p_collection_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_collection record;
  v_already_reversed boolean;
  v_txn_group uuid := gen_random_uuid();
  v_reversal_tracking text;
  v_commission numeric;
  v_rent_request record;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Please provide a reason (at least 5 characters)');
  END IF;

  -- Load the collection
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

  IF COALESCE(v_collection.notes, '') ILIKE '%[REVERSED]%' THEN
    RETURN jsonb_build_object('success', false, 'error', 'This allocation was already reversed');
  END IF;

  -- Check that the linked rent_request still exists
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

  v_reversal_tracking := 'REV-' || v_collection.tracking_id;
  v_commission := ROUND(v_collection.amount * 0.10);

  PERFORM set_config('ledger.authorized', 'true', true);

  -- Mirror entries (reverse direction)
  INSERT INTO public.general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
  VALUES (v_collection.agent_id, v_collection.amount, 'cash_in', 'agent_float_used_for_rent', 'agent_collections', v_rent_request.id,
    format('Reversal of float allocation — %s. Reason: %s', v_reversal_tracking, p_reason), 'wallet', v_txn_group);

  INSERT INTO public.general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
  VALUES (v_collection.agent_id, v_collection.amount, 'cash_out', 'tenant_repayment', 'agent_collections', v_rent_request.id,
    format('Reversal of tenant repayment — %s', v_reversal_tracking), 'platform', v_txn_group);

  -- Reverse commission if it was earned
  IF v_commission > 0 THEN
    INSERT INTO public.general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
    VALUES (v_collection.agent_id, v_commission, 'cash_out', 'agent_commission_earned', 'agent_collections', v_rent_request.id,
      format('Commission reversal for allocation — %s', v_reversal_tracking), 'wallet', v_txn_group);

    INSERT INTO public.general_ledger (user_id, amount, direction, category, source_table, source_id, description, ledger_scope, transaction_group_id)
    VALUES (v_collection.agent_id, v_commission, 'cash_in', 'agent_commission_earned', 'agent_collections', v_rent_request.id,
      format('Reversed commission expense — %s', v_reversal_tracking), 'platform', v_txn_group);
  END IF;

  -- Restore tenant debt
  UPDATE public.rent_requests
  SET amount_repaid = GREATEST(0, amount_repaid - v_collection.amount),
      status = CASE
        WHEN status = 'completed' THEN 'repaying'
        ELSE status
      END,
      updated_at = NOW()
  WHERE id = v_rent_request.id;

  -- Mark repayment record as reversed (insert a negative-equivalent record)
  INSERT INTO public.repayments (tenant_id, rent_request_id, amount, created_at)
  VALUES (v_collection.tenant_id, v_rent_request.id, -v_collection.amount, NOW());

  -- Annotate the original collection so the UI knows it was reversed
  UPDATE public.agent_collections
  SET notes = COALESCE(notes, '') || ' [REVERSED: ' || p_reason || ']'
  WHERE id = p_collection_id;

  RETURN jsonb_build_object(
    'success', true,
    'reversal_tracking_id', v_reversal_tracking,
    'amount_returned', v_collection.amount,
    'commission_clawed_back', v_commission,
    'rent_request_id', v_rent_request.id
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.agent_reverse_tenant_allocation(uuid, text) TO authenticated;
