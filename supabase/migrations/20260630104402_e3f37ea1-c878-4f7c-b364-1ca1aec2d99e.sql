-- Lock down the partner-agreements storage bucket to folder ownership + ops staff.
DROP POLICY IF EXISTS "Authenticated can read partner agreements" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can upload partner agreements" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can update partner agreements" ON storage.objects;

-- Owners (folder named after their uid) and ops staff can read agreement files.
CREATE POLICY "Owner or ops can read partner agreements"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'partner-agreements'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR public.is_ops_role(auth.uid())
  )
);

-- Users may only upload into their own folder; ops staff may upload anywhere.
CREATE POLICY "Owner or ops can upload partner agreements"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'partner-agreements'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR public.is_ops_role(auth.uid())
  )
);

-- Users may only overwrite files in their own folder; ops staff may update anywhere.
CREATE POLICY "Owner or ops can update partner agreements"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'partner-agreements'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR public.is_ops_role(auth.uid())
  )
)
WITH CHECK (
  bucket_id = 'partner-agreements'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR public.is_ops_role(auth.uid())
  )
);