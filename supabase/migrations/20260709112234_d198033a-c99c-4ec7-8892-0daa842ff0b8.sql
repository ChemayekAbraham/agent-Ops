
-- Allow a new edit_type for funding corrections
ALTER TABLE public.landlord_payment_edits
  DROP CONSTRAINT IF EXISTS landlord_payment_edits_edit_type_check;
ALTER TABLE public.landlord_payment_edits
  ADD CONSTRAINT landlord_payment_edits_edit_type_check
  CHECK (edit_type = ANY (ARRAY['rent_amount'::text,'landlord_payout'::text,'outstanding_balance'::text,'landlord_funding'::text]));

CREATE OR REPLACE FUNCTION public.ops_edit_landlord_funding(
  p_rent_request_id uuid,
  p_new_amount numeric,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_rr record;
  v_alloc record;
  v_old numeric;
  v_delta numeric;
  v_landlord_name text;
  v_group uuid;
  v_edit_id uuid;
  v_key text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT public.is_ops_role(v_actor) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;
  IF p_new_amount IS NULL OR p_new_amount <= 0 THEN
    RAISE EXCEPTION 'Amount is invalid';
  END IF;

  SELECT id, tenant_id, landlord_id, COALESCE(assigned_agent_id, agent_id) AS agent_id, rent_amount
    INTO v_rr
    FROM public.rent_requests
   WHERE id = p_rent_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent request not found';
  END IF;

  SELECT name INTO v_landlord_name FROM public.landlords WHERE id = v_rr.landlord_id;

  SELECT * INTO v_alloc
    FROM public.agent_landlord_float_allocations
   WHERE rent_request_id = p_rent_request_id
   ORDER BY created_at DESC
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No landlord funding allocation exists for this tenant to edit';
  END IF;
  IF COALESCE(v_alloc.paid_out_amount, 0) > 0 THEN
    RAISE EXCEPTION 'Cannot change funding after the landlord has been paid (UGX % already paid out)', v_alloc.paid_out_amount;
  END IF;

  v_old := COALESCE(v_alloc.allocated_amount, 0);
  v_delta := p_new_amount - v_old;

  IF v_delta = 0 THEN
    RETURN jsonb_build_object('unchanged', true, 'amount', p_new_amount);
  END IF;

  UPDATE public.agent_landlord_float_allocations
     SET allocated_amount = p_new_amount,
         remaining_amount = p_new_amount,
         updated_at = now()
   WHERE id = v_alloc.id;

  v_key := 'ops_funding_edit:' || p_rent_request_id::text || ':' || extract(epoch FROM now())::bigint::text;

  IF v_delta > 0 THEN
    v_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'direction','cash_out','amount',v_delta,'category','rent_disbursement','ledger_scope','platform',
          'source_table','rent_requests','source_id',p_rent_request_id,'currency','UGX',
          'user_id',v_rr.agent_id,'linked_party',v_rr.landlord_id,
          'description', format('Ops funding increase (+UGX %s) for landlord %s. Request %s', v_delta, COALESCE(v_landlord_name,'Unknown'), left(p_rent_request_id::text,8))
        ),
        jsonb_build_object(
          'direction','cash_in','amount',v_delta,'category','rent_receivable_created','ledger_scope','bridge',
          'source_table','rent_requests','source_id',p_rent_request_id,'currency','UGX',
          'user_id',v_rr.agent_id,'linked_party',v_rr.landlord_id,
          'description', format('Landlord float increased (+UGX %s) - %s', v_delta, COALESCE(v_landlord_name,'Unknown'))
        )
      ),
      v_key,
      true
    );
  ELSE
    v_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'direction','cash_in','amount',abs(v_delta),'category','rent_disbursement','ledger_scope','platform',
          'source_table','rent_requests','source_id',p_rent_request_id,'currency','UGX',
          'user_id',v_rr.agent_id,'linked_party',v_rr.landlord_id,
          'description', format('Ops funding decrease (-UGX %s) for landlord %s. Request %s', abs(v_delta), COALESCE(v_landlord_name,'Unknown'), left(p_rent_request_id::text,8))
        ),
        jsonb_build_object(
          'direction','cash_out','amount',abs(v_delta),'category','rent_receivable_created','ledger_scope','bridge',
          'source_table','rent_requests','source_id',p_rent_request_id,'currency','UGX',
          'user_id',v_rr.agent_id,'linked_party',v_rr.landlord_id,
          'description', format('Landlord float reduced (-UGX %s) - %s', abs(v_delta), COALESCE(v_landlord_name,'Unknown'))
        )
      ),
      v_key,
      true
    );
  END IF;

  INSERT INTO public.landlord_payment_edits (
    edit_type, rent_request_id, tenant_id, agent_id, landlord_name,
    old_amount, new_amount, reason, edited_by, edited_by_name
  ) VALUES (
    'landlord_funding', p_rent_request_id, v_rr.tenant_id, v_rr.agent_id, v_landlord_name,
    v_old, p_new_amount, trim(p_reason), v_actor,
    (SELECT full_name FROM public.profiles WHERE id = v_actor)
  ) RETURNING id INTO v_edit_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_actor, 'ops.edit_landlord_funding', 'agent_landlord_float_allocations', v_alloc.id::text,
    jsonb_build_object(
      'rent_request_id', p_rent_request_id, 'old_amount', v_old, 'new_amount', p_new_amount,
      'delta', v_delta, 'reason', trim(p_reason), 'ledger_group', v_group, 'edit_id', v_edit_id
    )
  );

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
    VALUES (
      'landlord_funding.edited', v_rr.agent_id, 'agent_landlord_float_allocations', v_alloc.id,
      jsonb_build_object('rent_request_id', p_rent_request_id, 'old_amount', v_old,
        'new_amount', p_new_amount, 'delta', v_delta, 'edited_by', v_actor)
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'edit_id', v_edit_id, 'old_amount', v_old, 'new_amount', p_new_amount,
    'delta', v_delta, 'ledger_group', v_group
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.ops_edit_landlord_funding(uuid, numeric, text) TO authenticated;
