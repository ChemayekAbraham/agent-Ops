ALTER TABLE public.agent_advances
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid,
  ADD COLUMN IF NOT EXISTS reversal_reason text,
  ADD COLUMN IF NOT EXISTS reversal_amount numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reversal_clawback_group_id uuid;

CREATE OR REPLACE FUNCTION public.reverse_agent_advance(
  p_advance_id uuid,
  p_reason text,
  p_clawback_amount numeric DEFAULT 0,
  p_clawback_group_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_adv RECORD;
  v_prev_outstanding numeric;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (public.has_role(v_caller, 'cfo'::app_role)
       OR public.has_role(v_caller, 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO or Manager can reverse a disbursed advance';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reversal reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_adv FROM public.agent_advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Advance not found';
  END IF;

  IF v_adv.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Advance already reversed';
  END IF;

  v_prev_outstanding := COALESCE(v_adv.outstanding_balance, 0);

  UPDATE public.agent_advances SET
    status = 'cancelled',
    outstanding_balance = 0,
    arrears_balance = 0,
    daily_installment = 0,
    deduction_paused = true,
    cancelled_at = COALESCE(cancelled_at, now()),
    cancelled_by = COALESCE(cancelled_by, v_caller),
    cancellation_reason = COALESCE(cancellation_reason, p_reason),
    cancellation_mode = 'write_off',
    pre_cancel_outstanding = COALESCE(pre_cancel_outstanding, v_prev_outstanding),
    reversed_at = now(),
    reversed_by = v_caller,
    reversal_reason = p_reason,
    reversal_amount = GREATEST(0, COALESCE(p_clawback_amount, 0)),
    reversal_clawback_group_id = p_clawback_group_id,
    updated_at = now()
  WHERE id = p_advance_id;

  IF v_adv.request_id IS NOT NULL THEN
    UPDATE public.agent_advance_requests
    SET updated_at = now()
    WHERE id = v_adv.request_id;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_caller,
    'agent_advance_reversed',
    'agent_advances',
    p_advance_id,
    jsonb_build_object(
      'reason', p_reason,
      'agent_id', v_adv.agent_id,
      'principal', v_adv.principal,
      'previous_outstanding', v_prev_outstanding,
      'clawback_amount', GREATEST(0, COALESCE(p_clawback_amount, 0)),
      'clawback_group_id', p_clawback_group_id
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'advance_id', p_advance_id,
    'previous_outstanding', v_prev_outstanding,
    'clawback_amount', GREATEST(0, COALESCE(p_clawback_amount, 0))
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reverse_agent_advance(uuid, text, numeric, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_agent_advance(uuid, text, numeric, uuid) TO authenticated;