CREATE OR REPLACE FUNCTION public.ops_record_payment_edit(
  p_edit_type text,
  p_target_id uuid,
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
  v_actor_name text;
  v_old numeric;
  v_tenant uuid;
  v_agent uuid;
  v_landlord_name text;
  v_rent_request_id uuid;
  v_payout_id uuid;
  v_edit_id uuid;
  v_new_total numeric;
  v_new_daily numeric;
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
    RAISE EXCEPTION 'Amount must be positive';
  END IF;
  IF p_edit_type NOT IN ('rent_amount','landlord_payout') THEN
    RAISE EXCEPTION 'Invalid edit type';
  END IF;

  SELECT full_name INTO v_actor_name FROM public.profiles WHERE id = v_actor;

  IF p_edit_type = 'rent_amount' THEN
    SELECT rent_amount, tenant_id, COALESCE(assigned_agent_id, agent_id)
      INTO v_old, v_tenant, v_agent
      FROM public.rent_requests WHERE id = p_target_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Rent request not found';
    END IF;
    v_rent_request_id := p_target_id;

    UPDATE public.rent_requests
       SET rent_amount = p_new_amount, updated_at = now()
     WHERE id = p_target_id
     RETURNING total_repayment, daily_repayment INTO v_new_total, v_new_daily;
  ELSE
    SELECT amount, tenant_id, agent_id, landlord_name, rent_request_id
      INTO v_old, v_tenant, v_agent, v_landlord_name, v_rent_request_id
      FROM public.agent_landlord_payouts WHERE id = p_target_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Landlord payout not found';
    END IF;
    v_payout_id := p_target_id;

    UPDATE public.agent_landlord_payouts
       SET amount = p_new_amount, updated_at = now()
     WHERE id = p_target_id;
  END IF;

  INSERT INTO public.landlord_payment_edits (
    edit_type, rent_request_id, payout_id, tenant_id, agent_id, landlord_name,
    old_amount, new_amount, reason, edited_by, edited_by_name
  ) VALUES (
    p_edit_type, v_rent_request_id, v_payout_id, v_tenant, v_agent, v_landlord_name,
    COALESCE(v_old, 0), p_new_amount, trim(p_reason), v_actor, v_actor_name
  ) RETURNING id INTO v_edit_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_actor,
    'ops.record_payment_edit',
    CASE WHEN p_edit_type = 'rent_amount' THEN 'rent_requests' ELSE 'agent_landlord_payouts' END,
    p_target_id::text,
    jsonb_build_object(
      'edit_type', p_edit_type,
      'reason', trim(p_reason),
      'old_amount', COALESCE(v_old, 0),
      'new_amount', p_new_amount,
      'agent_id', v_agent,
      'edit_id', v_edit_id
    )
  );

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
    VALUES (
      'payment_edit.recorded', v_agent, 'landlord_payment_edits', v_edit_id,
      jsonb_build_object('edit_id', v_edit_id, 'edit_type', p_edit_type,
        'old_amount', COALESCE(v_old,0), 'new_amount', p_new_amount,
        'tenant_id', v_tenant, 'edited_by', v_actor)
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'edit_id', v_edit_id,
    'old_amount', COALESCE(v_old, 0),
    'new_amount', p_new_amount,
    'agent_id', v_agent
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.agent_respond_payment_edit(
  p_edit_id uuid,
  p_response text,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_agent uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_response NOT IN ('agreed','disputed') THEN
    RAISE EXCEPTION 'Invalid response';
  END IF;

  SELECT agent_id INTO v_agent FROM public.landlord_payment_edits WHERE id = p_edit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Edit not found';
  END IF;
  IF v_agent IS DISTINCT FROM v_actor AND NOT public.is_ops_role(v_actor) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  IF p_response = 'disputed' AND (p_note IS NULL OR length(trim(p_note)) < 5) THEN
    RAISE EXCEPTION 'Dispute note must be at least 5 characters';
  END IF;

  UPDATE public.landlord_payment_edits
     SET agent_response = p_response,
         agent_responded_at = now(),
         agent_dispute_note = CASE WHEN p_response = 'disputed' THEN trim(p_note) ELSE NULL END
   WHERE id = p_edit_id;

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
    VALUES ('payment_edit.responded', v_actor, 'landlord_payment_edits', p_edit_id,
      jsonb_build_object('edit_id', p_edit_id, 'response', p_response));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('edit_id', p_edit_id, 'response', p_response);
END;
$function$;