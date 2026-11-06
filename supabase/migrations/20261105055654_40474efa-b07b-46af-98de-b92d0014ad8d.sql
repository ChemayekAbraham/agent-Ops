DROP POLICY IF EXISTS "wh tenant id photo upload by agent" ON storage.objects;
CREATE POLICY "wh tenant id photo upload by agent" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'wh-tenant-id-photos'
  AND (storage.foldername(name))[1] = ((SELECT auth.uid()))::text
  AND (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND public._wh_is_tenant_agent((SELECT auth.uid()),
        CASE WHEN (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN ((storage.foldername(name))[2])::uuid END)
);