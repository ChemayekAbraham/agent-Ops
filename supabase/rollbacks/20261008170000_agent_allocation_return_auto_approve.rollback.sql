-- Rollback for 20261008170000_agent_allocation_return_auto_approve.sql
-- Restores the two original functions (every send-back waits for the CFO again) and
-- removes everything the migration added.
--
-- NOTE: dropping auto_approved loses which past send-backs were automatic. The rows
-- themselves, the ledger entries and the audit trail are untouched.

DROP TRIGGER IF EXISTS trg_a0_block_send_back_self_approval ON public.rent_requests;
DROP FUNCTION IF EXISTS public.block_send_back_agent_self_approval();
DROP FUNCTION IF EXISTS public.agent_edit_sent_back_rent_plan(uuid, numeric, text);

CREATE OR REPLACE FUNCTION public.request_allocation_return(p_allocation_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_alloc  public.agent_landlord_float_allocations%ROWTYPE;
  v_amount numeric;
  v_req_id uuid;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated.');
  END IF;
  IF p_reason IS NULL OR char_length(trim(p_reason)) < 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Please provide a reason (10+ characters).');
  END IF;

  SELECT * INTO v_alloc
    FROM public.agent_landlord_float_allocations
   WHERE id = p_allocation_id
   FOR UPDATE;

  IF v_alloc.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Allocation not found.');
  END IF;
  IF v_alloc.agent_id <> v_caller THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authorized.');
  END IF;
  IF v_alloc.status NOT IN ('open','partially_paid') THEN
    RETURN jsonb_build_object('success', false, 'error', 'This allocation cannot be returned.');
  END IF;

  v_amount := v_alloc.remaining_amount;
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nothing left to return on this allocation.');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.agent_allocation_return_requests
     WHERE allocation_id = p_allocation_id AND status = 'pending'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'A CFO approval is already pending for this landlord.');
  END IF;

  INSERT INTO public.agent_allocation_return_requests (
    agent_id, allocation_id, rent_request_id, landlord_id, landlord_name, amount, reason
  ) VALUES (
    v_caller, v_alloc.id, v_alloc.rent_request_id, v_alloc.landlord_id,
    v_alloc.landlord_name, v_amount, trim(p_reason)
  ) RETURNING id INTO v_req_id;

  UPDATE public.agent_landlord_float_allocations
     SET status = 'return_pending', updated_at = now()
   WHERE id = v_alloc.id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_caller, 'request_allocation_return', 'agent_allocation_return_requests', v_req_id,
          jsonb_build_object('allocation_id', v_alloc.id, 'rent_request_id', v_alloc.rent_request_id,
                             'amount', v_amount, 'reason', trim(p_reason)));

  INSERT INTO public.system_events (event_type, user_id, metadata)
  VALUES ('agent.allocation_return.requested', v_caller, jsonb_build_object(
    'request_id', v_req_id, 'allocation_id', v_alloc.id, 'rent_request_id', v_alloc.rent_request_id,
    'landlord_id', v_alloc.landlord_id, 'landlord_name', v_alloc.landlord_name, 'amount', v_amount));

  RETURN jsonb_build_object('success', true, 'request_id', v_req_id,
                            'amount', v_amount, 'landlord_name', v_alloc.landlord_name);
END;
$function$;

CREATE OR REPLACE FUNCTION public.cfo_decide_allocation_return(p_request_id uuid, p_decision text, p_cfo_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller    uuid := auth.uid();
  v_req       public.agent_allocation_return_requests%ROWTYPE;
  v_alloc     public.agent_landlord_float_allocations%ROWTYPE;
  v_new_group uuid;
  v_fee_rev   jsonb;
BEGIN

  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated.');
  END IF;
  IF NOT public.can_act_pinned_finance_action(v_caller) THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Only the Chief Finance Officer or a designated super admin may return landlord float.');
  END IF;
  IF p_decision NOT IN ('approve','reject') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Decision must be approve or reject.');
  END IF;

  SELECT * INTO v_req FROM public.agent_allocation_return_requests WHERE id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Request not found.');
  END IF;
  IF v_req.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Request already ' || v_req.status || '.');
  END IF;

  SELECT * INTO v_alloc FROM public.agent_landlord_float_allocations WHERE id = v_req.allocation_id FOR UPDATE;

  IF p_decision = 'reject' THEN
    UPDATE public.agent_allocation_return_requests
       SET status = 'rejected', cfo_id = v_caller, cfo_decision_at = now(),
           cfo_note = p_cfo_note, updated_at = now()
     WHERE id = p_request_id;

    IF v_alloc.id IS NOT NULL AND v_alloc.status = 'return_pending' THEN
      UPDATE public.agent_landlord_float_allocations
         SET status = CASE WHEN COALESCE(paid_out_amount,0) > 0 THEN 'partially_paid' ELSE 'open' END,
             updated_at = now()
       WHERE id = v_alloc.id;
    END IF;

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (v_caller, 'cfo_reject_allocation_return', 'agent_allocation_return_requests', p_request_id,
            jsonb_build_object('cfo_note', p_cfo_note));
    INSERT INTO public.system_events (event_type, user_id, metadata)
    VALUES ('agent.allocation_return.rejected', v_caller, jsonb_build_object(
      'request_id', p_request_id, 'agent_id', v_req.agent_id, 'cfo_note', p_cfo_note));

    RETURN jsonb_build_object('success', true, 'status', 'rejected');
  END IF;

  -- APPROVE
  BEGIN
    v_fee_rev := public.reverse_funding_treasury(v_req.rent_request_id);
  EXCEPTION WHEN OTHERS THEN
    v_fee_rev := jsonb_build_object('status','error','message',SQLERRM);
    RAISE WARNING 'reverse_funding_treasury failed for %: %', v_req.rent_request_id, SQLERRM;
  END;

  SELECT public.create_ledger_transaction(entries := jsonb_build_array(
    jsonb_build_object(
      'user_id', v_req.agent_id, 'amount', v_req.amount, 'direction', 'cash_in',
      'category', 'rent_disbursement', 'ledger_scope', 'platform', 'classification', 'production',
      'currency', 'UGX', 'source_table', 'rent_requests', 'source_id', v_req.rent_request_id,
      'linked_party', v_req.landlord_id,
      'description', format('CFO-approved allocation return — float returned to CFO for %s', COALESCE(v_req.landlord_name,'landlord')),
      'transaction_date', now()
    ),
    jsonb_build_object(
      'user_id', v_req.agent_id, 'amount', v_req.amount, 'direction', 'cash_out',
      'category', 'rent_receivable_created', 'ledger_scope', 'bridge', 'classification', 'production',
      'currency', 'UGX', 'source_table', 'rent_requests', 'source_id', v_req.rent_request_id,
      'linked_party', v_req.landlord_id,
      'description', format('Reversal — CFO-approved allocation return (%s)', COALESCE(v_req.landlord_name,'landlord')),
      'transaction_date', now()
    )
  ), idempotency_key := 'allocation-return:'||p_request_id::text) INTO v_new_group;

  UPDATE public.agent_landlord_float
     SET balance = GREATEST(0, COALESCE(balance,0) - v_req.amount),
         total_funded = GREATEST(0, COALESCE(total_funded,0) - v_req.amount),
         updated_at = now()
   WHERE agent_id = v_req.agent_id;

  IF v_alloc.id IS NOT NULL THEN
    UPDATE public.agent_landlord_float_allocations
       SET status = 'cancelled',
           notes = COALESCE(notes,'') || ' | Returned to CFO: ' || v_req.reason,
           updated_at = now()
     WHERE id = v_alloc.id;
  END IF;

  IF v_req.rent_request_id IS NOT NULL THEN
    UPDATE public.rent_requests
       SET status = CASE WHEN status = 'funded' THEN 'agent_ops_approved' ELSE status END,
           updated_at = now()
     WHERE id = v_req.rent_request_id;
  END IF;

  UPDATE public.agent_allocation_return_requests
     SET status = 'approved', cfo_id = v_caller, cfo_decision_at = now(),
         cfo_note = p_cfo_note, reversal_transaction_group = v_new_group, updated_at = now()
   WHERE id = p_request_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_caller, 'cfo_approve_allocation_return', 'agent_allocation_return_requests', p_request_id,
          jsonb_build_object('cfo_note', p_cfo_note, 'amount', v_req.amount,
                             'reversal_transaction_group', v_new_group,
                             'fee_recognition_reversal', v_fee_rev));
  INSERT INTO public.system_events (event_type, user_id, metadata)
  VALUES ('agent.allocation_return.approved', v_caller, jsonb_build_object(
    'request_id', p_request_id, 'agent_id', v_req.agent_id, 'amount', v_req.amount,
    'reversal_transaction_group', v_new_group));

  RETURN jsonb_build_object('success', true, 'status', 'approved',
                            'amount_returned', v_req.amount, 'landlord_name', v_req.landlord_name,
                            'fee_recognition_reversal', v_fee_rev);
END;
$function$;

DROP FUNCTION IF EXISTS public._complete_allocation_return(uuid, uuid, text, boolean);
DROP INDEX IF EXISTS public.idx_aarr_auto_approved_plan;
ALTER TABLE public.agent_allocation_return_requests DROP COLUMN IF EXISTS auto_approved;
