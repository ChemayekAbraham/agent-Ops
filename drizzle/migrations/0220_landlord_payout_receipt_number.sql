ALTER TABLE public.agent_landlord_payouts
  ADD COLUMN IF NOT EXISTS receipt_number text,
  ADD COLUMN IF NOT EXISTS receipt_number_recorded_at timestamptz;

CREATE OR REPLACE FUNCTION public.agent_record_landlord_payout_receipt(
  p_payout_id uuid,
  p_receipt_number text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payout public.agent_landlord_payouts%ROWTYPE;
  v_receipt text := btrim(COALESCE(p_receipt_number, ''));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  IF char_length(v_receipt) < 3 OR char_length(v_receipt) > 50 THEN
    RAISE EXCEPTION 'RECEIPT_NUMBER_INVALID: enter the receipt number exactly as written on the landlord''s signed receipt (3-50 characters).';
  END IF;

  SELECT * INTO v_payout
  FROM public.agent_landlord_payouts
  WHERE id = p_payout_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT_NOT_FOUND';
  END IF;

  IF v_payout.agent_id <> auth.uid() THEN
    RAISE EXCEPTION 'NOT_YOUR_PAYOUT';
  END IF;

  IF v_payout.status IN ('rejected', 'cancelled', 'failed') THEN
    RAISE EXCEPTION 'PAYOUT_NOT_ACTIVE: this payout is % and cannot take a receipt number.', v_payout.status;
  END IF;

  UPDATE public.agent_landlord_payouts
  SET receipt_number = v_receipt,
      receipt_number_recorded_at = now(),
      updated_at = now()
  WHERE id = p_payout_id;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, performed_by, metadata)
  VALUES (
    'landlord_payout_receipt_number_recorded',
    'agent_landlord_payouts',
    p_payout_id,
    'Agent recorded the landlord-signed receipt number for this payout.',
    auth.uid(),
    jsonb_build_object('receipt_number', v_receipt, 'landlord_name', v_payout.landlord_name, 'amount', v_payout.amount)
  );

  INSERT INTO public.system_events (event_type, user_id, metadata)
  VALUES (
    'agent.landlord_payout.receipt_number_recorded',
    auth.uid(),
    jsonb_build_object('payout_id', p_payout_id, 'receipt_number', v_receipt, 'amount', v_payout.amount)
  );

  RETURN jsonb_build_object('success', true, 'payout_id', p_payout_id, 'receipt_number', v_receipt);
END;
$$;

GRANT EXECUTE ON FUNCTION public.agent_record_landlord_payout_receipt(uuid, text) TO authenticated;