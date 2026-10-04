DROP POLICY IF EXISTS "Agents can upload product images" ON storage.objects;
CREATE POLICY "Agents can upload product images"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'products'::text
  AND has_role(auth.uid(), 'agent'::app_role)
  AND (storage.foldername(name))[1] = (auth.uid())::text
);