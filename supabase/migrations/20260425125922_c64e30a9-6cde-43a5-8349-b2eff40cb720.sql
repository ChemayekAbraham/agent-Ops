CREATE OR REPLACE FUNCTION public.process_verified_field_deposit(
  p_batch_id uuid,
  p_finops_user uuid,
  p_finops_proof_entered text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch              public.field_deposit_batches%ROWTYPE;
  v_item               RECORD;
  v_collection         public.field_collections%ROWTYPE;
  v_commission_rate    numeric := 0.10;
  v_commission         numeric;
  v_total_allocated    numeric := 0;
  v_total_commission   numeric := 0;
  v_surplus            numeric := 0;
  v_tagged_total       numeric := 0;
  v_allocation_count   integer := 0;
  v_tenant_breakdown   jsonb := '[]'::jsonb;
  v_now                timestamptz := now();
BEGIN
  SELECT * INTO v_batch FROM public.field_deposit_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch not found';
  END IF;
  IF v_batch.status <> 'pending_finops_verification' THEN
    RAISE EXCEPTION 'Batch is in status % and cannot be verified', v_batch.status;
  END IF;

  PERFORM public.apply_wallet_movement(
    v_batch.agent_id, 'agent_float_deposit', v_batch.declared_total, 'in'
  );

  FOR v_item IN
    SELECT bi.id AS item_id, bi.amount, bi.field_collection_id
    FROM public.field_deposit_batch_items bi
    WHERE bi.batch_id = p_batch_id
  LOOP
    SELECT * INTO v_collection FROM public.field_collections WHERE id = v_item.field_collection_id FOR UPDATE;

    UPDATE public.field_collections
       SET status = 'confirmed', confirmed_at = v_now
     WHERE id = v_item.field_collection_id;

    INSERT INTO public.agent_landlord_float_allocations (
      agent_id, tenant_id, allocated_amount, source, status, notes
    ) VALUES (
      v_batch.agent_id, v_collection.tenant_id, v_item.amount,
      'field_deposit_batch',
      'allocated',
      'Field deposit batch ' || p_batch_id::text
    );

    INSERT INTO public.agent_collections (
      agent_id, tenant_id, amount, payment_method, notes, float_before, float_after
    ) VALUES (
      v_batch.agent_id, v_collection.tenant_id, v_item.amount,
      'cash',
      'Auto-recorded from verified field deposit batch',
      0, 0
    );

    PERFORM public.apply_wallet_movement(
      v_batch.agent_id, 'agent_float_used_for_rent', v_item.amount, 'out'
    );

    v_commission := round(v_item.amount * v_commission_rate);
    IF v_commission > 0 THEN
      PERFORM public.apply_wallet_movement(v_batch.agent_id, 'agent_commission_earned', v_commission, 'in');
      INSERT INTO public.agent_earnings (agent_id, amount, earning_type, description)
      VALUES (v_batch.agent_id, v_commission, 'field_collection_commission',
              'Field collection commission for ' || COALESCE(v_collection.tenant_name, 'tenant'));
      UPDATE public.field_collections
         SET commission_amount = v_commission,
             commission_paid_at = v_now
       WHERE id = v_item.field_collection_id;
    END IF;

    v_tagged_total     := v_tagged_total + v_item.amount;
    v_total_allocated  := v_total_allocated + v_item.amount;
    v_total_commission := v_total_commission + v_commission;
    v_allocation_count := v_allocation_count + 1;

    v_tenant_breakdown := v_tenant_breakdown || jsonb_build_object(
      'item_id', v_item.item_id,
      'tenant_id', v_collection.tenant_id,
      'tenant_name', v_collection.tenant_name,
      'tenant_phone', v_collection.tenant_phone,
      'repayment', v_item.amount,
      'commission', v_commission,
      'generated_at', v_now
    );
  END LOOP;

  v_surplus := GREATEST(0, v_batch.declared_total - v_tagged_total);

  UPDATE public.field_deposit_batches
     SET status = 'verified',
         finops_verified_by = p_finops_user,
         finops_verified_at = v_now,
         finops_proof_entered = p_finops_proof_entered,
         tagged_total = v_tagged_total,
         surplus_total = v_surplus
   WHERE id = p_batch_id;

  INSERT INTO public.field_deposit_batch_audit (batch_id, event, actor_id, actor_role, details)
  VALUES (
    p_batch_id, 'allocation_completed', p_finops_user, 'system',
    jsonb_build_object(
      'allocations', v_allocation_count,
      'total_allocated', v_total_allocated,
      'total_commission', v_total_commission,
      'surplus_to_float', v_surplus,
      'commission_rate', v_commission_rate,
      'tenants', v_tenant_breakdown
    )
  );

  RETURN jsonb_build_object(
    'allocations', v_allocation_count,
    'total_allocated', v_total_allocated,
    'total_commission', v_total_commission,
    'surplus_to_float', v_surplus
  );
END;
$$;