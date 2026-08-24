CREATE OR REPLACE FUNCTION public.reverse_agent_advance(p_advance_id uuid, p_reason text, p_clawback_amount numeric DEFAULT 0, p_clawback_group_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_adv RECORD;
  v_req RECORD;
  v_prev_outstanding numeric;
  v_disbursed_amount numeric := 0;
  v_clawed numeric := 0;
  v_tag text;
  v_approved_at timestamptz;
  v_target_status text;
  v_withdrawable numeric := 0;
  v_remaining numeric := 0;
  v_shortfall numeric := 0;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (public.has_role(v_caller, 'cfo'::app_role)
       OR public.has_role(v_caller, 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO or Manager can reverse an advance';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reversal reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_adv FROM public.agent_advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Advance not found';
  END IF;

  -- Idempotency: the row lock plus this guard makes a second click a no-op error
  -- instead of a duplicate clawback / ledger entry / audit event.
  IF v_adv.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'ADVANCE_ALREADY_REVERSED: this advance was already reversed on %',
      to_char(v_adv.reversed_at AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY HH24:MI');
  END IF;

  IF v_adv.request_id IS NULL THEN
    RAISE EXCEPTION 'REVERSAL_NO_REQUEST: this advance has no originating request, so it cannot be sent back to Waiting for Approval. Use Cancel instead.';
  END IF;

  SELECT * INTO v_req FROM public.agent_advance_requests
  WHERE id = v_adv.request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REVERSAL_NO_REQUEST: the originating advance request no longer exists';
  END IF;

  v_approved_at := COALESCE(v_req.cfo_paid_at, v_req.cfo_approved_at, v_adv.issued_at);
  IF (v_approved_at AT TIME ZONE 'Africa/Kampala')::date
     <> (now() AT TIME ZONE 'Africa/Kampala')::date THEN
    RAISE EXCEPTION 'REVERSAL_WINDOW_CLOSED: only advances approved today can be reverted to Waiting for Approval (this one was approved on %)',
      to_char(v_approved_at AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY');
  END IF;

  v_tag := 'advance_reversal:' || p_advance_id::text;

  SELECT COALESCE(SUM(amount), 0) INTO v_disbursed_amount
  FROM public.general_ledger
  WHERE source_table = 'agent_advance_requests'
    AND source_id = v_adv.request_id
    AND category = 'agent_advance_credit'
    AND ledger_scope = 'wallet';

  SELECT COALESCE(SUM(amount), 0) INTO v_clawed
  FROM public.cfo_debit_obligations
  WHERE user_id = v_adv.agent_id
    AND metadata->>'sub_category' = v_tag;

  v_remaining := GREATEST(0, v_disbursed_amount - v_clawed);

  BEGIN
    v_withdrawable := COALESCE(public.get_user_available_balance(v_adv.agent_id), 0);
  EXCEPTION WHEN OTHERS THEN
    v_withdrawable := 0;
  END;

  -- Evidence gate: if money really left treasury and the agent still holds
  -- withdrawable funds, the CFO Direct Debit recovery must be on record first.
  -- When the agent's withdrawable funds cannot cover what is still outstanding,
  -- the reversal completes and the un-recovered part is recorded as a shortfall
  -- (the wallet is never driven negative).
  IF v_remaining > 0 AND v_withdrawable >= 1 THEN
    RAISE EXCEPTION 'REVERSAL_RECOVERY_MISSING: % UGX of this advance is still outstanding and the agent holds % UGX withdrawable. Run the wallet recovery step first.',
      v_remaining, v_withdrawable;
  END IF;

  v_shortfall := v_remaining;
  v_prev_outstanding := COALESCE(v_adv.outstanding_balance, 0);

  -- Stop the repayment / deduction schedule and clear the advance.
  UPDATE public.agent_advances SET
    status = 'cancelled',
    outstanding_balance = 0,
    arrears_balance = 0,
    daily_installment = 0,
    installment_amount = 0,
    deduction_paused = true,
    cancelled_at = COALESCE(cancelled_at, now()),
    cancelled_by = COALESCE(cancelled_by, v_caller),
    cancellation_reason = COALESCE(cancellation_reason, p_reason),
    cancellation_mode = 'write_off',
    pre_cancel_outstanding = COALESCE(pre_cancel_outstanding, v_prev_outstanding),
    reversed_at = now(),
    reversed_by = v_caller,
    reversal_reason = CASE
      WHEN v_shortfall > 0 THEN p_reason || ' [unrecovered shortfall: ' || v_shortfall::text || ' UGX]'
      ELSE p_reason END,
    reversal_amount = GREATEST(0, COALESCE(v_clawed, 0)),
    reversal_clawback_group_id = p_clawback_group_id,
    updated_at = now()
  WHERE id = p_advance_id;

  v_target_status := CASE
    WHEN v_req.reviewed_by_agent_ops IS NOT NULL THEN 'agent_ops_approved'
    ELSE 'pending'
  END;

  UPDATE public.agent_advance_requests SET
    status = v_target_status,
    cfo_approved_by = NULL,
    cfo_approved_at = NULL,
    paid_by_cfo = NULL,
    cfo_paid_at = NULL,
    cfo_notes = COALESCE(NULLIF(trim(cfo_notes), '') || E'\n', '')
                || 'Reverted to Waiting for Approval: ' || p_reason,
    updated_at = now()
  WHERE id = v_adv.request_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (
    v_caller,
    'agent_advance_reversed',
    'agent_advances',
    p_advance_id,
    p_reason,
    jsonb_build_object(
      'reason', p_reason,
      'agent_id', v_adv.agent_id,
      'request_id', v_adv.request_id,
      'principal', v_adv.principal,
      'previous_outstanding', v_prev_outstanding,
      'was_disbursed', v_disbursed_amount > 0,
      'disbursed_amount', v_disbursed_amount,
      'clawback_amount', GREATEST(0, COALESCE(v_clawed, 0)),
      'unrecovered_shortfall', v_shortfall,
      'agent_withdrawable_at_reversal', v_withdrawable,
      'clawback_group_id', p_clawback_group_id,
      'request_status_after', v_target_status
    )
  );

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES ('funds_withdrawn', v_adv.agent_id, 'agent_advances', p_advance_id,
    jsonb_build_object(
      'description', 'Agent advance reverted to Waiting for Approval',
      'actor_id', v_caller,
      'request_id', v_adv.request_id,
      'was_disbursed', v_disbursed_amount > 0,
      'clawback_amount', GREATEST(0, COALESCE(v_clawed, 0)),
      'unrecovered_shortfall', v_shortfall,
      'reason', p_reason
    ));

  RETURN jsonb_build_object(
    'success', true,
    'advance_id', p_advance_id,
    'request_id', v_adv.request_id,
    'was_disbursed', v_disbursed_amount > 0,
    'disbursed_amount', v_disbursed_amount,
    'clawback_amount', GREATEST(0, COALESCE(v_clawed, 0)),
    'unrecovered_shortfall', v_shortfall,
    'previous_outstanding', v_prev_outstanding,
    'request_status', v_target_status
  );
END;
$function$;