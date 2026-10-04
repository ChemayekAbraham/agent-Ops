
-- =============================================
-- Fix: Tighten payment-proofs storage to user-scoped access
-- Users can only view their own files, managers can view all
-- =============================================

-- Drop the overly broad policy
DROP POLICY IF EXISTS "Authenticated users view payment proofs" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can view payment proofs" ON storage.objects;

-- Users can view their own payment proofs (stored in user_id/ folder)
CREATE POLICY "Users view own payment proofs"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'payment-proofs'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR has_role(auth.uid(), 'manager')
  )
);

-- Users can only upload to their own folder
DROP POLICY IF EXISTS "Authenticated users can upload payment proofs" ON storage.objects;
CREATE POLICY "Users upload to own folder payment proofs"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'payment-proofs'
  AND (storage.foldername(name))[1] = auth.uid()::text
);
