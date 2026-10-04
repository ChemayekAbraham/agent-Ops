-- 1. Add target_bucket column
ALTER TABLE public.field_deposit_batches
  ADD COLUMN IF NOT EXISTS target_bucket text NOT NULL DEFAULT 'operational_float';

ALTER TABLE public.field_deposit_batches
  DROP CONSTRAINT IF EXISTS field_deposit_batches_target_bucket_check;

ALTER TABLE public.field_deposit_batches
  ADD CONSTRAINT field_deposit_batches_target_bucket_check
  CHECK (target_bucket IN ('operational_float','withdrawable'));

-- 2. Replace process_verified_field_deposit to branch on target_bucket
CREATE OR REPLACE FUNCTION public.process_verified_field_deposit(
  p_batch_id uuid,
  p_finops_user uuid,
  p_finops_proof_entered text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_batch              public.field_deposit_batches%ROWTYPE;
  v_item               RECORD;
  v_collection         public.field_collections%ROWTYPE;
  v_commission_rate    numeric;
  v_commission         numeric;
  v_total_allocated    numeric := 0;
  v_total_commission   numeric := 0;
  v_surplus            numeric := 0;
  v_tagged_total       numeric := 0;
  v_allocation_count   integer := 0;
  v_tenant_breakdown   jsonb := '[]'::jsonb;
  v_now                timestamptz := now();
  v_ref                text;
BEGIN
  SELECT * INTO v_batch FROM public.field_deposit_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch not found';
  END IF;
  IF v_batch.status <> 'pending_finops_verification' THEN
    RAISE EXCEPTION 'Batch is in status % and cannot be verified', v_batch.status;
  END IF;

  -- ─── Branch on the agent's target bucket choice ───────────────────────
  IF v_batch.target_bucket = 'withdrawable' THEN
    -- Reject if agent accidentally tagged tenants in withdrawable mode
    SELECT COALESCE(SUM(amount), 0)
      INTO v_tagged_total
      FROM public.field_deposit_batch_items
     WHERE batch_id = p_batch_id;

    IF v_tagged_total > 0 THEN
      RAISE EXCEPTION
        'Batch is in withdrawable mode but has tagged tenant items (total %). Untag items or switch mode.',
        v_tagged_total;
    END IF;

    v_ref := 'FD-' || substring(p_batch_id::text, 1, 8);

    -- Single double-entry: agent withdrawable receives cash, platform records the cash inflow
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id',         v_batch.agent_id,
          'amount',          v_batch.declared_total,
          'direction',       'cash_in',
          'category',        'wallet_deposit',
          'ledger_scope',    'wallet',
          'recipient_type',  'user',
          'wallet_bucket',   'withdrawable',
          'routing_source',  'field_deposit_batch_withdrawable',
          'source_table',    'field_deposit_batches',
          'source_id',       p_batch_id,
          'reference_id',    v_ref,
          'description',     'Field deposit to personal withdrawable wallet · batch ' || p_batch_id::text,
          'currency',        'UGX',
          'transaction_date', v_now
        ),
        jsonb_build_object(
          'user_id',         p_finops_user,
          'amount',          v_batch.declared_total,
          'direction',       'cash_out',
          'category',        'deposit',
          'ledger_scope',    'platform',
          'source_table',    'field_deposit_batches',
          'source_id',       p_batch_id,
          'reference_id',    v_ref,
          'description',     'Cash banked by agent → credited to agent withdrawable · batch ' || p_batch_id::text,
          'currency',        'UGX',
          'transaction_date', v_now
        )
      ),
      'field_deposit_withdrawable:' || p_batch_id::text,
      true
    );

    UPDATE public.field_deposit_batches
       SET status = 'verified',
           finops_verified_by = p_finops_user,
           finops_verified_at = v_now,
           finops_proof_entered = p_finops_proof_entered,
           tagged_total = 0,
           surplus_total = 0
     WHERE id = p_batch_id;

    INSERT INTO public.field_deposit_batch_audit (batch_id, event, actor_id, actor_role, details)
    VALUES (
      p_batch_id, 'allocation_completed', p_finops_user, 'system',
      jsonb_build_object(
        'mode',           'withdrawable_topup',
        'allocations',    0,
        'total_allocated', v_batch.declared_total,
        'total_commission', 0,
        'surplus_to_float', 0,
        'target_bucket',   'withdrawable'
      )
    );

    RETURN jsonb_build_object(
      'mode',            'withdrawable_topup',
      'allocations',     0,
      'total_allocated', v_batch.declared_total,
      'total_commission', 0,
      'surplus_to_float', 0,
      'target_bucket',   'withdrawable'
    );
  END IF;

  -- ─── Default: operational_float mode (unchanged legacy behavior) ──────
  SELECT rate INTO v_commission_rate
  FROM public.field_deposit_commission_config
  WHERE is_active = true
  ORDER BY updated_at DESC
  LIMIT 1;

  IF v_commission_rate IS NULL THEN
    RAISE EXCEPTION 'Field deposit commission config is missing — cannot verify batch %', p_batch_id;
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
      'item_id',      v_item.item_id,
      'tenant_id',    v_collection.tenant_id,
      'tenant_name',  v_collection.tenant_name,
      'tenant_phone', v_collection.tenant_phone,
      'repayment',    v_item.amount,
      'commission',   v_commission,
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
      'mode',            'operational_float',
      'allocations',     v_allocation_count,
      'total_allocated', v_total_allocated,
      'total_commission', v_total_commission,
      'surplus_to_float', v_surplus,
      'commission_rate',  v_commission_rate,
      'target_bucket',    'operational_float',
      'tenants',          v_tenant_breakdown
    )
  );

  RETURN jsonb_build_object(
    'mode',            'operational_float',
    'allocations',     v_allocation_count,
    'total_allocated', v_total_allocated,
    'total_commission', v_total_commission,
    'surplus_to_float', v_surplus,
    'commission_rate',  v_commission_rate,
    'target_bucket',    'operational_float'
  );
END;
$function$;