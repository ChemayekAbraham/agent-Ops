-- 1. Protect reviewer GPS coordinates in house_reviews from public/other-user reads
REVOKE SELECT (latitude, longitude, accuracy) ON public.house_reviews FROM anon, authenticated;

-- 2. Protect plaintext PIN and PIN hash in vendors from anon/authenticated reads
REVOKE SELECT (pin, pin_hash) ON public.vendors FROM anon, authenticated;

-- Manager-only helper to know whether a vendor has a PIN set, without exposing the value
CREATE OR REPLACE FUNCTION public.manager_vendor_pin_flags()
RETURNS TABLE(vendor_id uuid, has_pin boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT v.id, (v.pin IS NOT NULL OR v.pin_hash IS NOT NULL)
  FROM public.vendors v
  WHERE public.has_role(auth.uid(), 'manager')
$$;
GRANT EXECUTE ON FUNCTION public.manager_vendor_pin_flags() TO authenticated;

-- 3. reviews storage bucket: require folder ownership on upload
DROP POLICY IF EXISTS "Authenticated users can upload review images" ON storage.objects;
CREATE POLICY "Users can upload own review images"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'reviews'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- 4. service-centre-photos storage bucket: require folder ownership on upload
DROP POLICY IF EXISTS "Authenticated users can upload service centre photos" ON storage.objects;
CREATE POLICY "Users can upload own service centre photos"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'service-centre-photos'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- 5. email-assets storage bucket: restrict writes to managers
DROP POLICY IF EXISTS "Authenticated can upload email assets" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can update email assets" ON storage.objects;
CREATE POLICY "Managers can upload email assets"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'email-assets' AND public.has_role(auth.uid(), 'manager'));
CREATE POLICY "Managers can update email assets"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'email-assets' AND public.has_role(auth.uid(), 'manager'))
WITH CHECK (bucket_id = 'email-assets' AND public.has_role(auth.uid(), 'manager'));