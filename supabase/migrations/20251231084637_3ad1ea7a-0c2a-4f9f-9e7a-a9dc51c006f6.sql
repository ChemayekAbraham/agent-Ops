-- Create storage bucket for product images
INSERT INTO storage.buckets (id, name, public)
VALUES ('products', 'products', true);

-- Allow authenticated users to upload product images
CREATE POLICY "Agents can upload product images"
ON storage.objects
FOR INSERT
WITH CHECK (
  bucket_id = 'products' 
  AND auth.uid() IS NOT NULL
  AND has_role(auth.uid(), 'agent')
);

-- Allow anyone to view product images (public bucket)
CREATE POLICY "Anyone can view product images"
ON storage.objects
FOR SELECT
USING (bucket_id = 'products');

-- Allow agents to update their own product images
CREATE POLICY "Agents can update own product images"
ON storage.objects
FOR UPDATE
USING (
  bucket_id = 'products'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Allow agents to delete their own product images
CREATE POLICY "Agents can delete own product images"
ON storage.objects
FOR DELETE
USING (
  bucket_id = 'products'
  AND auth.uid()::text = (storage.foldername(name))[1]
);