CREATE POLICY "Agents update own house images"
ON storage.objects
FOR UPDATE
TO authenticated
USING (bucket_id = 'house-images' AND (storage.foldername(name))[1] = (auth.uid())::text)
WITH CHECK (bucket_id = 'house-images' AND (storage.foldername(name))[1] = (auth.uid())::text);