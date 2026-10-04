CREATE OR REPLACE FUNCTION public.detect_payout_proof_integrity()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.payout_proof_integrity_alerts (issue_type, severity, withdrawal_id, details)
  SELECT 'proof_missing', 'medium', w.id,
         jsonb_build_object('amount', w.amount, 'processed_at', w.processed_at)
  FROM public.withdrawal_requests w
  WHERE w.status = 'completed'
    AND w.payout_proof IS NULL
    AND COALESCE(w.processed_at, w.created_at) > now() - interval '60 days'
    AND NOT EXISTS (
      SELECT 1 FROM public.payout_proof_integrity_alerts a
      WHERE a.withdrawal_id = w.id AND a.issue_type = 'proof_missing' AND NOT a.resolved
    );

  INSERT INTO public.payout_proof_integrity_alerts (issue_type, severity, withdrawal_id, details)
  SELECT 'invalid_storage_reference', 'high', w.id,
         jsonb_build_object('payout_proof', left(w.payout_proof, 200))
  FROM public.withdrawal_requests w
  WHERE w.payout_proof IS NOT NULL
    AND w.payout_proof ~* '^https?://'
    AND w.payout_proof_path IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.payout_proof_integrity_alerts a
      WHERE a.withdrawal_id = w.id AND a.issue_type = 'invalid_storage_reference' AND NOT a.resolved
    );

  INSERT INTO public.payout_proof_integrity_alerts (issue_type, severity, withdrawal_id, storage_path, details)
  SELECT 'missing_storage_object', 'critical', w.id, w.payout_proof_path,
         jsonb_build_object('bucket', COALESCE(w.payout_proof_bucket, 'payment-proofs'))
  FROM public.withdrawal_requests w
  WHERE w.payout_proof_path IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM storage.objects o
      WHERE o.bucket_id = COALESCE(w.payout_proof_bucket, 'payment-proofs')
        AND o.name = w.payout_proof_path
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.payout_proof_integrity_alerts a
      WHERE a.withdrawal_id = w.id AND a.issue_type = 'missing_storage_object' AND NOT a.resolved
    );

  INSERT INTO public.payout_proof_integrity_alerts (issue_type, severity, storage_path, details)
  SELECT 'orphaned_storage_file', 'low', o.name,
         jsonb_build_object('created_at', o.created_at)
  FROM storage.objects o
  WHERE o.bucket_id = 'payment-proofs'
    AND o.name ILIKE '%payout-proofs/%'
    AND NOT EXISTS (
      SELECT 1 FROM public.withdrawal_requests w WHERE w.payout_proof_path = o.name
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.payout_proof_integrity_alerts a
      WHERE a.storage_path = o.name AND a.issue_type = 'orphaned_storage_file' AND NOT a.resolved
    );

  RETURN jsonb_build_object('ok', true, 'ran_at', now());
END;
$$;