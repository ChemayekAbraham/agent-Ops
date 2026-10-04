CREATE OR REPLACE FUNCTION public.merchant_attach_payout_proof(
  p_withdrawal_id uuid,
  p_path text,
  p_bucket text DEFAULT 'payment-proofs',
  p_type text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row withdrawal_requests;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_path IS NULL OR btrim(p_path) = '' THEN
    RAISE EXCEPTION 'Proof path is required';
  END IF;

  SELECT * INTO v_row FROM withdrawal_requests WHERE id = p_withdrawal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payout not found';
  END IF;

  IF v_row.processed_by IS DISTINCT FROM auth.uid()
     AND NOT public.is_withdrawal_staff(auth.uid()) THEN
    RAISE EXCEPTION 'You can only attach proof to payouts you settled';
  END IF;

  UPDATE withdrawal_requests
     SET payout_proof_path = p_path,
         payout_proof_bucket = COALESCE(p_bucket, 'payment-proofs'),
         payout_proof_type = p_type,
         payout_proof_uploaded_by = auth.uid(),
         payout_proof_uploaded_at = now()
   WHERE id = p_withdrawal_id;

  INSERT INTO audit_logs (action_type, table_name, record_id, user_id, reason, metadata)
  VALUES ('payout_proof_attached', 'withdrawal_requests', p_withdrawal_id, auth.uid(),
          'Merchant attached missing payout proof after settlement',
          jsonb_build_object('path', p_path, 'bucket', COALESCE(p_bucket, 'payment-proofs')));

  RETURN jsonb_build_object('success', true, 'withdrawal_id', p_withdrawal_id);
END;
$$;

REVOKE ALL ON FUNCTION public.merchant_attach_payout_proof(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merchant_attach_payout_proof(uuid, text, text, text) TO authenticated;