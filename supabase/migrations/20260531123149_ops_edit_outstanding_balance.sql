-- Allow Tenant Ops operators to directly adjust a tenant's outstanding rent
-- balance (not just the rent amount). Extends ops_record_payment_edit with a
-- new 'outstanding_balance' edit type that recomputes amount_repaid from the
-- desired outstanding figure, keeping the existing audit + agent-agreement flow.

ALTER TABLE public.landlord_payment_edits
  DROP CONSTRAINT IF EXISTS landlord_payment_edits_edit_type_check;
ALTER TABLE public.landlord_payment_edits
  ADD CONSTRAINT landlord_payment_edits_edit_type_check
  CHECK (edit_type = ANY (ARRAY['rent_amount'::text, 'landlord_payout'::text, 'outstanding_balance'::text]));

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
  v_total numeric;
  v_new_repaid numeric;
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
  IF p_edit_type NOT IN ('rent_amount','landlord_payout','outstanding_balance') THEN
    RAISE EXCEPTION 'Invalid edit type';
  END IF;
  -- Outstanding balance may legitimately be set to 0 (fully paid); other edit
  -- types must remain strictly positive.
  IF p_new_amount IS NULL OR (p_edit_type = 'outstanding_balance' AND p_new_amount < 0)
     OR (p_edit_type <> 'outstanding_balance' AND p_new_amount <= 0) THEN
    RAISE EXCEPTION 'Amount is invalid';
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
     WHERE id = p_target_id;

  ELSIF p_edit_type = 'outstanding_balance' THEN
    SELECT (total_repayment - amount_repaid), total_repayment, tenant_id,
           COALESCE(assigned_agent_id, agent_id)
      INTO v_old, v_total, v_tenant, v_agent
      FROM public.rent_requests WHERE id = p_target_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Rent request not found';
    END IF;
    v_rent_request_id := p_target_id;

    -- Clamp the requested outstanding balance to the plan total, then derive
    -- the new amount_repaid from it.
    v_new_repaid := GREATEST(0, v_total - LEAST(p_new_amount, v_total));

    UPDATE public.rent_requests
       SET amount_repaid = v_new_repaid,
           status = CASE
                      WHEN v_new_repaid >= v_total THEN 'completed'
                      WHEN status = 'completed' THEN 'repaying'
                      ELSE status
                    END,
           updated_at = now()
     WHERE id = p_target_id;

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
    CASE WHEN p_edit_type = 'landlord_payout' THEN 'agent_landlord_payouts' ELSE 'rent_requests' END,
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
