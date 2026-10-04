-- Private bucket for offline collection proof (photos, signatures).
-- Files stored as: <agent_id>/<draft_id>/<photo|signature>.<ext>
INSERT INTO storage.buckets (id, name, public)
VALUES ('offline-collection-proof', 'offline-collection-proof', false)
ON CONFLICT (id) DO NOTHING;

-- Agent can read their own proof files
CREATE POLICY "Agents can view own offline proof"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'offline-collection-proof'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Agent can upload their own proof files
CREATE POLICY "Agents can upload own offline proof"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'offline-collection-proof'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Agent can delete their own proof files (e.g. when retaking)
CREATE POLICY "Agents can delete own offline proof"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'offline-collection-proof'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Financial Ops / COO / CFO can view all proof for audit
CREATE POLICY "Finance ops can view all offline proof"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'offline-collection-proof'
  AND EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND role IN ('cfo', 'coo', 'operations', 'super_admin')
  )
);