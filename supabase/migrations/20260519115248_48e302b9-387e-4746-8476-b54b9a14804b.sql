CREATE OR REPLACE FUNCTION public.agent_unallocate_tenant_payment(
  p_agent_id uuid,
  p_rent_request_id uuid,
  p_original_transaction_group uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller         uuid := auth.uid();
  v_amount         numeric;
  v_landlord_id    uuid;
  v_landlord_name  text;
  v_commission     numeric;
  v_new_group      uuid := gen_random_uuid();
  v_tracking       text;
  v_rr_landlord    uuid;
  v_orig_created   timestamptz;
BEGIN
  IF v_caller IS NULL OR v_caller <> p_agent_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authorized.');
  END IF;

  IF p_reason IS NULL OR char_length(trim(p_reason)) < 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Please provide a reason (10+ characters).');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.agent_tenant_float_reversals
    WHERE original_transaction_group = p_original_transaction_group
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'This funding has already been marked not funded.');
  END IF;

  SELECT gl.amount, gl.linked_party::uuid, gl.created_at
    INTO v_amount, v_landlord_id, v_orig_created
  FROM public.general_ledger gl
  WHERE gl.reference_id = p_original_transaction_group::text
    AND gl.user_id = p_agent_id
    AND gl.category = 'rent_payment_for_tenant'
    AND gl.direction = 'cash_out'
    AND gl.ledger_scope = 'wallet'
  ORDER BY gl.created_at DESC
  LIMIT 1;

  IF v_amount IS NULL OR v_landlord_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Original funding not found.');
  END IF;

  IF v_orig_created < now() - interval '7 days' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Funding older than 7 days — contact support.');
  END IF;

  SELECT landlord_id INTO v_rr_landlord
  FROM public.rent_requests
  WHERE id = p_rent_request_id;

  IF v_rr_landlord IS NULL OR v_rr_landlord <> v_landlord_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent plan does not match the original funding.');
  END IF;

  v_commission := round(v_amount * 0.10);
  v_tracking   := substr(v_new_group::text, 1, 8);

  SELECT COALESCE(l.name, p.full_name, 'Landlord')
    INTO v_landlord_name
  FROM (SELECT v_landlord_id AS id) x
  LEFT JOIN public.landlords l ON l.id = x.id
  LEFT JOIN public.profiles p ON p.id = x.id;

  PERFORM public.create_ledger_transaction(
    'agent_tenant_float_allocation_reversal',
    jsonb_build_array(
      jsonb_build_object(
        'user_id', p_agent_id, 'amount', v_amount, 'direction', 'cash_in',
        'category', 'rent_payment_for_tenant', 'ledger_scope', 'wallet',
        'classification', 'production',
        'description', format('Tenant marked not funded — float returned to %s (%s)', v_landlord_name, v_tracking),
        'linked_party', v_landlord_id, 'reference_id', v_new_group::text,
        'recipient_type', 'operational_wallet'
      ),
      jsonb_build_object(
        'user_id', v_landlord_id, 'amount', v_amount, 'direction', 'cash_out',
        'category', 'rent_payment_received', 'ledger_scope', 'wallet',
        'classification', 'production',
        'description', format('Reversal — tenant marked not funded (%s)', v_tracking),
        'linked_party', p_agent_id, 'reference_id', v_new_group::text,
        'recipient_type', 'user'
      ),
      jsonb_build_object(
        'user_id', p_agent_id, 'amount', v_commission, 'direction', 'cash_out',
        'category', 'agent_commission_earned', 'ledger_scope', 'wallet',
        'classification', 'production',
        'description', format('10%% commission clawback — %s', v_tracking),
        'reference_id', v_new_group::text, 'recipient_type', 'user'
      ),
      jsonb_build_object(
        'user_id', p_agent_id, 'amount', v_commission, 'direction', 'cash_in',
        'category', 'agent_commission_payable', 'ledger_scope', 'platform',
        'classification', 'production',
        'description', format('Platform commission reversal (%s)', v_tracking),
        'reference_id', v_new_group::text
      )
    )
  );

  UPDATE public.rent_requests
     SET amount_repaid = GREATEST(0, COALESCE(amount_repaid, 0) - v_amount),
         status = CASE
                    WHEN status = 'completed'
                      AND (GREATEST(0, COALESCE(amount_repaid, 0) - v_amount) < COALESCE(total_repayment, 0))
                    THEN 'repaying'
                    ELSE status
                  END,
         updated_at = now()
   WHERE id = p_rent_request_id;

  INSERT INTO public.agent_tenant_float_reversals (
    agent_id, rent_request_id, landlord_id, landlord_name,
    original_transaction_group, reversal_transaction_group,
    amount, commission_clawback, reason
  ) VALUES (
    p_agent_id, p_rent_request_id, v_landlord_id, v_landlord_name,
    p_original_transaction_group, v_new_group,
    v_amount, v_commission, p_reason
  );

  INSERT INTO public.audit_logs (
    user_id, action_type, table_name, record_id, metadata
  ) VALUES (
    p_agent_id,
    'agent_unallocate_tenant_payment',
    'rent_requests',
    p_rent_request_id,
    jsonb_build_object(
      'reason', p_reason,
      'amount', v_amount,
      'commission_clawback', v_commission,
      'landlord_id', v_landlord_id,
      'landlord_name', v_landlord_name,
      'original_transaction_group', p_original_transaction_group,
      'reversal_transaction_group', v_new_group
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'amount_returned', v_amount,
    'commission_clawback', v_commission,
    'landlord_name', v_landlord_name,
    'reversal_transaction_group', v_new_group
  );
END;
$$;