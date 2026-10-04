-- 1. Permanent storage references on withdrawal_requests (metadata only)
ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS payout_proof_path text,
  ADD COLUMN IF NOT EXISTS payout_proof_bucket text,
  ADD COLUMN IF NOT EXISTS payout_proof_uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS payout_proof_uploaded_by uuid;

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_payout_proof_path
  ON public.withdrawal_requests (payout_proof_path)
  WHERE payout_proof_path IS NOT NULL;

-- 2. Safe backfill: derive object path from existing signed/public URLs.
--    Only touches proof metadata columns. Legacy non-URL text is ignored.
UPDATE public.withdrawal_requests w
SET
  payout_proof_bucket = 'payment-proofs',
  payout_proof_path = split_part(
    regexp_replace(w.payout_proof, '^.*/storage/v1/object/(?:sign|public|authenticated)/payment-proofs/', ''),
    '?', 1
  ),
  payout_proof_uploaded_at = COALESCE(w.payout_proof_uploaded_at, w.processed_at, w.updated_at)
WHERE w.payout_proof IS NOT NULL
  AND w.payout_proof_path IS NULL
  AND w.payout_proof ~ '/storage/v1/object/(sign|public|authenticated)/payment-proofs/';

-- 3. Storage read access for finance + executive roles (bucket stays PRIVATE)
DROP POLICY IF EXISTS "Finance roles can view payout proofs" ON storage.objects;
CREATE POLICY "Finance roles can view payout proofs"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'payment-proofs'
  AND (
    public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'financial_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
  )
);

-- 4. Integrity alerts table
CREATE TABLE IF NOT EXISTS public.payout_proof_integrity_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_type text NOT NULL,
  severity text NOT NULL DEFAULT 'medium',
  withdrawal_id uuid,
  storage_path text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved boolean NOT NULL DEFAULT false,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.payout_proof_integrity_alerts TO authenticated;
GRANT ALL ON public.payout_proof_integrity_alerts TO service_role;

ALTER TABLE public.payout_proof_integrity_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Finance roles view proof integrity alerts" ON public.payout_proof_integrity_alerts;
CREATE POLICY "Finance roles view proof integrity alerts"
ON public.payout_proof_integrity_alerts FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'financial_ops'::app_role)
  OR public.has_role(auth.uid(), 'operations'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
);

DROP POLICY IF EXISTS "Finance roles resolve proof integrity alerts" ON public.payout_proof_integrity_alerts;
CREATE POLICY "Finance roles resolve proof integrity alerts"
ON public.payout_proof_integrity_alerts FOR UPDATE
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'financial_ops'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
)
WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.touch_payout_proof_integrity_alerts()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_payout_proof_integrity_alerts ON public.payout_proof_integrity_alerts;
CREATE TRIGGER trg_touch_payout_proof_integrity_alerts
BEFORE UPDATE ON public.payout_proof_integrity_alerts
FOR EACH ROW EXECUTE FUNCTION public.touch_payout_proof_integrity_alerts();

-- 5. Reconciliation report (read-only)
CREATE OR REPLACE FUNCTION public.get_payout_proof_integrity_report()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'financial_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  WITH completed AS (
    SELECT id, payout_proof, payout_proof_path
    FROM public.withdrawal_requests
    WHERE status = 'completed'
  ),
  storage_files AS (
    SELECT name
    FROM storage.objects
    WHERE bucket_id = 'payment-proofs'
      AND name ILIKE '%payout-proofs/%'
  )
  SELECT jsonb_build_object(
    'total_completed', (SELECT count(*) FROM completed),
    'with_proof', (SELECT count(*) FROM completed WHERE payout_proof IS NOT NULL),
    'missing_proof', (SELECT count(*) FROM completed WHERE payout_proof IS NULL),
    'legacy_records', (SELECT count(*) FROM completed
                        WHERE payout_proof IS NOT NULL AND payout_proof !~* '^https?://'),
    'invalid_references', (SELECT count(*) FROM completed
                        WHERE payout_proof IS NOT NULL
                          AND payout_proof ~* '^https?://'
                          AND payout_proof_path IS NULL),
    'expired_url_legacy', (SELECT count(*) FROM completed
                        WHERE payout_proof IS NOT NULL
                          AND payout_proof ~* '/storage/v1/object/sign/'
                          AND payout_proof_path IS NULL),
    'storage_objects', (SELECT count(*) FROM storage_files),
    'orphaned_storage_files', (
      SELECT count(*) FROM storage_files s
      WHERE NOT EXISTS (SELECT 1 FROM completed c WHERE c.payout_proof_path = s.name)
    ),
    'missing_storage_objects', (
      SELECT count(*) FROM completed c
      WHERE c.payout_proof_path IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM storage_files s WHERE s.name = c.payout_proof_path)
    ),
    'generated_at', now()
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_payout_proof_integrity_report() FROM public;
GRANT EXECUTE ON FUNCTION public.get_payout_proof_integrity_report() TO authenticated;

-- 6. Scheduled detector — writes alerts only, never financial data
CREATE OR REPLACE FUNCTION public.detect_payout_proof_integrity()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted int := 0;
BEGIN
  -- Completed merchant payouts without any proof (last 60 days)
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
  v_inserted := v_inserted + ROW_COUNT_SAFE();

  -- Proof URL stored but no resolvable storage path
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

  -- Storage path recorded but object no longer present
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

  -- Storage object with no linked withdrawal
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

REVOKE ALL ON FUNCTION public.detect_payout_proof_integrity() FROM public;
GRANT EXECUTE ON FUNCTION public.detect_payout_proof_integrity() TO service_role;

SELECT cron.schedule(
  'detect-payout-proof-integrity',
  '25 2 * * *',
  $$SELECT public.detect_payout_proof_integrity();$$
);