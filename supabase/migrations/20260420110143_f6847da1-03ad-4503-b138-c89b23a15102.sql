CREATE OR REPLACE FUNCTION public.refund_agent_float_for_payout(p_payout_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_payout public.landlord_payouts%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR length(p_reason) < 10 THEN
    RAISE EXCEPTION 'Refund reason must be at least 10 characters';
  END IF;

  SELECT * INTO v_payout FROM public.landlord_payouts WHERE id = p_payout_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout % not found', p_payout_id; END IF;

  IF v_payout.status = 'completed' THEN
    RAISE EXCEPTION 'Cannot refund a completed payout';
  END IF;

  IF v_payout.status IN ('failed','refunded','escalated') THEN
    -- idempotent: already terminal
    RETURN jsonb_build_object('ok', true, 'noop', true, 'status', v_payout.status);
  END IF;

  PERFORM 1 FROM public.agent_landlord_float WHERE agent_id = v_payout.agent_id FOR UPDATE;

  UPDATE public.agent_landlord_float
  SET balance = COALESCE(balance, 0) + v_payout.amount,
      total_paid_out = GREATEST(COALESCE(total_paid_out, 0) - v_payout.amount, 0),
      updated_at = now()
  WHERE agent_id = v_payout.agent_id;

  -- Atomically transition the payout to a terminal failed state so it can never
  -- get stuck in 'disbursing' if the calling edge function crashes after refund.
  UPDATE public.landlord_payouts
  SET status = 'failed',
      last_error = p_reason,
      escalated_at = now(),
      escalated_reason = p_reason,
      updated_at = now()
  WHERE id = p_payout_id;

  RETURN jsonb_build_object('ok', true, 'refunded', v_payout.amount, 'reason', p_reason, 'status', 'failed');
END;
$function$;