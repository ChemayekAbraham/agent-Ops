-- ─────────────────────────────────────────────────────────────────
-- resubmit_rejected_deposit(p_id, p_payload)
-- Allows the depositor (auth.uid() = user_id) to fix and resubmit a
-- deposit that Financial Ops rejected. SECURITY DEFINER bypasses RLS
-- but the function itself enforces ownership + status='rejected'.
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resubmit_rejected_deposit(
  p_id uuid,
  p_payload jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_row public.deposit_requests%ROWTYPE;
  v_old_reason text;
  v_old_audit jsonb;
  v_new_audit jsonb;
  v_history jsonb;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
  FROM public.deposit_requests
  WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Deposit not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_row.user_id <> v_user THEN
    RAISE EXCEPTION 'Not allowed to resubmit this deposit' USING ERRCODE = '42501';
  END IF;

  IF v_row.status <> 'rejected' THEN
    RAISE EXCEPTION 'Only rejected deposits can be resubmitted (current: %)', v_row.status
      USING ERRCODE = '22023';
  END IF;

  v_old_reason := v_row.rejection_reason;
  v_old_audit  := COALESCE(v_row.purpose_audit, '{}'::jsonb);

  -- Append a resubmission record to a history array kept inside purpose_audit
  -- so we never lose what was rejected and why.
  v_history := COALESCE(v_old_audit -> 'resubmissions', '[]'::jsonb);
  v_history := v_history || jsonb_build_object(
    'resubmitted_at', now(),
    'previous_amount', v_row.amount,
    'previous_transaction_id', v_row.transaction_id,
    'previous_provider', v_row.provider,
    'previous_rejection_reason', v_old_reason
  );

  v_new_audit := v_old_audit
    || jsonb_build_object(
         'last_resubmitted_at', now(),
         'last_resubmitted_by', v_user,
         'resubmissions', v_history
       );

  UPDATE public.deposit_requests
  SET
    amount           = COALESCE((p_payload->>'amount')::numeric, amount),
    transaction_id   = COALESCE(p_payload->>'transaction_id', transaction_id),
    provider         = COALESCE(p_payload->>'provider', provider),
    transaction_date = COALESCE((p_payload->>'transaction_date')::timestamptz, transaction_date),
    notes            = COALESCE(p_payload->>'notes', notes),
    deposit_purpose  = COALESCE(p_payload->>'deposit_purpose', deposit_purpose),
    purpose_audit    = v_new_audit,
    status           = 'pending',
    rejection_reason = NULL,
    updated_at       = now()
  WHERE id = p_id;

  -- Audit log (mandatory: action_type, table_name, record_id, reason ≥10 chars)
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (
    v_user,
    'deposit_resubmitted',
    'deposit_requests',
    p_id,
    'User resubmitted a previously rejected deposit',
    jsonb_build_object(
      'previous_rejection_reason', v_old_reason,
      'new_amount', (p_payload->>'amount')::numeric,
      'new_transaction_id', p_payload->>'transaction_id'
    )
  );

  -- System event so Financial Ops dashboards and trust pipelines see it.
  INSERT INTO public.system_events (event_type, user_id, payload)
  VALUES (
    'deposit.resubmitted',
    v_user,
    jsonb_build_object(
      'deposit_request_id', p_id,
      'previous_rejection_reason', v_old_reason
    )
  );

  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.resubmit_rejected_deposit(uuid, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.resubmit_rejected_deposit(uuid, jsonb) TO authenticated;