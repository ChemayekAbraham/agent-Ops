
-- Create house-images storage bucket (public for tenant viewing)
INSERT INTO storage.buckets (id, name, public)
VALUES ('house-images', 'house-images', true)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload to their own folder
CREATE POLICY "Agents upload house images"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'house-images' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Allow authenticated users to delete their own images
CREATE POLICY "Agents delete own house images"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'house-images' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Public read access for tenants
CREATE POLICY "Public view house images"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'house-images');
