-- DEVELOPMENT ONLY: unapplied proposal; production application requires explicit approval.
BEGIN;

ALTER TABLE public.standing_order_audit_log
  DROP CONSTRAINT standing_order_audit_log_action_check;
ALTER TABLE public.standing_order_audit_log
  ADD CONSTRAINT standing_order_audit_log_action_check
  CHECK (action IN ('create', 'pause', 'resume', 'cancel', 'amount_edit'));

CREATE OR REPLACE FUNCTION public.standing_order_set_amount(
  p_order_id uuid,
  p_expected_amount numeric,
  p_expected_updated_at timestamptz,
  p_new_amount numeric,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_before public.scheduled_payouts%ROWTYPE;
  v_after public.scheduled_payouts%ROWTYPE;
  v_audit_id uuid;
  v_actor_name text;
  v_recipient_name text;
BEGIN
  IF v_actor IS NULL OR NOT (
    public.has_role(v_actor, 'cfo'::public.app_role)
    OR public.has_role(v_actor, 'super_admin'::public.app_role)
  ) OR NOT COALESCE(public.staff_mfa_ok(), false) THEN
    RAISE EXCEPTION 'Not authorized to change standing order amounts' USING ERRCODE = '42501';
  END IF;
  IF p_new_amount IS NULL OR p_new_amount::text IN ('NaN', 'Infinity', '-Infinity')
    OR p_new_amount <= 0 OR p_new_amount > 500000000 THEN
    RAISE EXCEPTION 'Amount must be greater than UGX 0 and at most UGX 500,000,000' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 OR length(btrim(p_reason)) > 1000 THEN
    RAISE EXCEPTION 'Provide a reason of 10 to 1000 characters' USING ERRCODE = '22023';
  END IF;
  IF p_order_id IS NULL OR p_expected_amount IS NULL OR p_expected_updated_at IS NULL THEN
    RAISE EXCEPTION 'The current standing order version is required' USING ERRCODE = '22023';
  END IF;

  -- Lock configuration only. A payer that already captured an amount is unaffected.
  SELECT * INTO v_before FROM public.scheduled_payouts WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Standing order not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_before.amount IS DISTINCT FROM p_expected_amount
    OR v_before.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Standing order changed. Refresh and review the current amount before trying again.' USING ERRCODE = '40001';
  END IF;
  IF v_before.amount = p_new_amount THEN
    RAISE EXCEPTION 'The new amount must differ from the current amount' USING ERRCODE = '22023';
  END IF;

  SELECT full_name INTO v_actor_name FROM public.profiles WHERE id = v_actor;
  SELECT full_name INTO v_recipient_name FROM public.profiles WHERE id = v_before.target_user_id;

  -- No enabled/date/schedule/run/history/payment/wallet/ledger writes.
  -- The existing BEFORE UPDATE trigger maintains updated_at.
  UPDATE public.scheduled_payouts SET amount = p_new_amount
    WHERE id = p_order_id RETURNING * INTO v_after;
  IF (to_jsonb(v_after) - 'amount' - 'updated_at') IS DISTINCT FROM
    (to_jsonb(v_before) - 'amount' - 'updated_at') THEN
    RAISE EXCEPTION 'Unexpected standing order configuration change';
  END IF;

  INSERT INTO public.standing_order_audit_log (
    scheduled_payout_id, action, acted_by, acted_by_name, target_user_id,
    recipient_name, amount, reason, details
  ) VALUES (
    p_order_id, 'amount_edit', v_actor, v_actor_name, v_before.target_user_id,
    v_recipient_name, v_after.amount, btrim(p_reason),
    jsonb_build_object('previous_amount', v_before.amount, 'new_amount', v_after.amount,
      'difference', v_after.amount - v_before.amount,
      'previous_updated_at', v_before.updated_at, 'new_updated_at', v_after.updated_at,
      'applies_to', 'future_scheduled_runs_only')
  ) RETURNING id INTO v_audit_id;
  -- Deliberately no exception handler: ANY audit error rolls back the update.
  RETURN jsonb_build_object('order', to_jsonb(v_after), 'audit_id', v_audit_id,
    'previous_amount', v_before.amount);
END;
$function$;

REVOKE ALL ON FUNCTION public.standing_order_set_amount(uuid, numeric, timestamptz, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.standing_order_set_amount(uuid, numeric, timestamptz, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.standing_order_set_amount(uuid, numeric, timestamptz, numeric, text) TO service_role;
COMMIT;