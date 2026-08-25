CREATE OR REPLACE FUNCTION public.reverse_agent_advance(p_advance_id uuid, p_reason text, p_clawback_amount numeric DEFAULT 0, p_clawback_group_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_adv RECORD;
  v_req RECORD;
  v_prev_outstanding numeric;
  v_disbursed_amount numeric := 0;
  v_clawed numeric := 0;
  v_prev_applied numeric := 0;
  v_new_claw numeric := 0;
  v_new_outstanding numeric := 0;
  v_tag text;
  v_approved_at timestamptz;
  v_target_status text;
  v_withdrawable numeric := 0;
  v_remaining numeric := 0;
  v_shortfall numeric := 0;
  v_fully_recovered boolean := false;
  v_window_days integer := 3;
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
     < ((now() AT TIME ZONE 'Africa/Kampala')::date - v_window_days) THEN
    RAISE EXCEPTION 'REVERSAL_WINDOW_CLOSED: only advances approved within the last % days can be reverted to Waiting for Approval (this one was approved on %)',
      v_window_days, to_char(v_approved_at AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY');
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

  IF v_remaining > 0 AND v_withdrawable >= 1 THEN
    RAISE EXCEPTION 'REVERSAL_RECOVERY_MISSING: % UGX of this advance is still outstanding and the agent holds % UGX withdrawable. Run the wallet recovery step first.',
      v_remaining, v_withdrawable;
  END IF;

  v_shortfall := v_remaining;
  v_fully_recovered := (v_shortfall <= 0);
  v_prev_outstanding := COALESCE(v_adv.outstanding_balance, 0);

  v_prev_applied := GREATEST(0, COALESCE(v_adv.reversal_amount, 0));
  v_new_claw := GREATEST(0, v_clawed - v_prev_applied);
  v_new_outstanding := GREATEST(0, v_prev_outstanding - v_new_claw);

  IF v_fully_recovered THEN
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
      cancellation_mode = 'recoup_from_wallet',
      pre_cancel_outstanding = COALESCE(pre_cancel_outstanding, v_prev_outstanding),
      reversed_at = now(),
      reversed_by = v_caller,
      reversal_reason = p_reason,
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
  ELSE
    UPDATE public.agent_advances SET
      status = CASE WHEN v_new_outstanding <= 0 THEN 'completed' ELSE 'active' END,
      outstanding_balance = v_new_outstanding,
      deduction_paused = false,
      reversal_amount = GREATEST(0, COALESCE(v_clawed, 0)),
      reversal_clawback_group_id = COALESCE(p_clawback_group_id, reversal_clawback_group_id),
      updated_at = now()
    WHERE id = p_advance_id;

    v_target_status := v_req.status;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (
    v_caller,
    CASE WHEN v_fully_recovered THEN 'agent_advance_reversed'
         ELSE 'agent_advance_partial_recovery' END,
    'agent_advances',
    p_advance_id,
    p_reason,
    jsonb_build_object(
      'reason', p_reason,
      'agent_id', v_adv.agent_id,
      'request_id', v_adv.request_id,
      'principal', v_adv.principal,
      'previous_outstanding', v_prev_outstanding,
      'outstanding_after', CASE WHEN v_fully_recovered THEN 0 ELSE v_new_outstanding END,
      'fully_recovered', v_fully_recovered,
      'was_disbursed', v_disbursed_amount > 0,
      'disbursed_amount', v_disbursed_amount,
      'clawback_amount', GREATEST(0, COALESCE(v_clawed, 0)),
      'clawback_applied_now', v_new_claw,
      'unrecovered_shortfall', v_shortfall,
      'agent_withdrawable_at_reversal', v_withdrawable,
      'clawback_group_id', p_clawback_group_id,
      'request_status_after', v_target_status
    )
  );

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES ('funds_withdrawn', v_adv.agent_id, 'agent_advances', p_advance_id,
    jsonb_build_object(
      'description', CASE WHEN v_fully_recovered
        THEN 'Agent advance fully recovered and reverted to Waiting for Approval'
        ELSE 'Agent advance partially recovered; remaining balance stays outstanding' END,
      'actor_id', v_caller,
      'request_id', v_adv.request_id,
      'was_disbursed', v_disbursed_amount > 0,
      'clawback_amount', GREATEST(0, COALESCE(v_clawed, 0)),
      'unrecovered_shortfall', v_shortfall,
      'outstanding_after', CASE WHEN v_fully_recovered THEN 0 ELSE v_new_outstanding END,
      'reason', p_reason
    ));

  RETURN jsonb_build_object(
    'success', true,
    'advance_id', p_advance_id,
    'request_id', v_adv.request_id,
    'fully_recovered', v_fully_recovered,
    'outcome', CASE WHEN v_fully_recovered THEN 'reversed' ELSE 'partial_recovery' END,
    'was_disbursed', v_disbursed_amount > 0,
    'disbursed_amount', v_disbursed_amount,
    'clawback_amount', GREATEST(0, COALESCE(v_clawed, 0)),
    'clawback_applied_now', v_new_claw,
    'unrecovered_shortfall', v_shortfall,
    'previous_outstanding', v_prev_outstanding,
    'outstanding_after', CASE WHEN v_fully_recovered THEN 0 ELSE v_new_outstanding END,
    'advance_still_active', NOT v_fully_recovered AND v_new_outstanding > 0,
    'request_status', v_target_status
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.advance_reversal_plan_batch(p_advance_ids uuid[] DEFAULT NULL::uuid[], p_today_only boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_rows jsonb;
  v_window_days integer := 3;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (public.has_role(v_caller, 'cfo'::app_role) OR public.has_role(v_caller, 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO or Manager can reverse an advance';
  END IF;

  WITH base AS (
    SELECT a.id, a.agent_id, a.request_id, a.status, a.principal,
           a.outstanding_balance, a.reversed_at, a.issued_at
    FROM public.agent_advances a
    WHERE (p_advance_ids IS NULL OR a.id = ANY(p_advance_ids))
      AND (
        p_advance_ids IS NOT NULL
        OR (
          a.reversed_at IS NULL
          AND (a.issued_at AT TIME ZONE 'Africa/Kampala')::date
              >= ((now() AT TIME ZONE 'Africa/Kampala')::date - v_window_days)
        )
      )
  ), enriched AS (
    SELECT
      b.*,
      r.status AS request_status,
      r.reviewed_by_agent_ops,
      COALESCE(r.cfo_paid_at, r.cfo_approved_at, b.issued_at) AS approved_at,
      p.full_name AS agent_name,
      p.phone AS agent_phone,
      COALESCE(d.disbursed_amount, 0) AS disbursed_amount,
      COALESCE(c.clawed, 0) AS clawback_posted_amount,
      COALESCE(public.get_user_advance_reversal_available(b.agent_id), 0) AS withdrawable
    FROM base b
    LEFT JOIN public.agent_advance_requests r ON r.id = b.request_id
    LEFT JOIN public.profiles p ON p.id = b.agent_id
    LEFT JOIN LATERAL (
      SELECT SUM(gl.amount) AS disbursed_amount
      FROM public.general_ledger gl
      WHERE gl.source_table = 'agent_advance_requests'
        AND gl.source_id = b.request_id
        AND gl.category = 'agent_advance_credit'
        AND gl.ledger_scope = 'wallet'
    ) d ON true
    LEFT JOIN LATERAL (
      SELECT SUM(o.amount) AS clawed
      FROM public.cfo_debit_obligations o
      WHERE o.user_id = b.agent_id
        AND o.metadata->>'sub_category' = 'advance_reversal:' || b.id::text
    ) c ON true
  )
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'agent_name' NULLS LAST), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT jsonb_build_object(
      'advance_id', e.id,
      'agent_id', e.agent_id,
      'agent_name', e.agent_name,
      'agent_phone', e.agent_phone,
      'request_id', e.request_id,
      'has_request', e.request_id IS NOT NULL,
      'status', e.status,
      'request_status', e.request_status,
      'principal', COALESCE(e.principal, 0),
      'outstanding_balance', COALESCE(e.outstanding_balance, 0),
      'already_reversed', e.reversed_at IS NOT NULL,
      'approved_at', e.approved_at,
      'approved_today', (e.approved_at AT TIME ZONE 'Africa/Kampala')::date
                        >= ((now() AT TIME ZONE 'Africa/Kampala')::date - v_window_days),
      'disbursed', e.disbursed_amount > 0,
      'disbursed_amount', e.disbursed_amount,
      'clawback_posted_amount', e.clawback_posted_amount,
      'amount_to_reverse', GREATEST(0, e.disbursed_amount - e.clawback_posted_amount),
      'withdrawable', e.withdrawable,
      'recoverable_now', GREATEST(0, LEAST(e.disbursed_amount - e.clawback_posted_amount, e.withdrawable)),
      'shortfall', GREATEST(0,
        GREATEST(0, e.disbursed_amount - e.clawback_posted_amount)
        - GREATEST(0, LEAST(e.disbursed_amount - e.clawback_posted_amount, e.withdrawable))),
      'clawback_tag', 'advance_reversal:' || e.id::text
    ) AS x
    FROM enriched e
    WHERE p_today_only = false
       OR p_advance_ids IS NOT NULL
       OR (e.approved_at AT TIME ZONE 'Africa/Kampala')::date
          >= ((now() AT TIME ZONE 'Africa/Kampala')::date - v_window_days)
  ) s;

  RETURN jsonb_build_object('rows', v_rows, 'count', jsonb_array_length(v_rows));
END;
$function$;