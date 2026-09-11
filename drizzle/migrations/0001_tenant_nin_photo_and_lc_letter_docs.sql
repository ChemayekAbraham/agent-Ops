-- 1. National ID photo lives on the rent request, mirroring the LC letter pair.
ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS nin_photo_path text,
  ADD COLUMN IF NOT EXISTS nin_photo_bucket text;

-- 2. tenant_documents gains the national_id document type (widening only).
ALTER TABLE public.tenant_documents
  DROP CONSTRAINT IF EXISTS tenant_documents_doc_type_check;
ALTER TABLE public.tenant_documents
  ADD CONSTRAINT tenant_documents_doc_type_check
  CHECK (doc_type = ANY (ARRAY['tenant_passport'::text, 'lc_letter'::text, 'house_image'::text, 'national_id'::text]));

-- 3. Register the National ID photo in tenant_documents alongside the others.
CREATE OR REPLACE FUNCTION public.sync_rent_request_tenant_documents()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.tenant_photo_url IS NOT NULL AND btrim(NEW.tenant_photo_url) <> '' THEN
    PERFORM public.register_tenant_document(
      NEW.tenant_id, 'tenant_passport', 'house-images', NULL,
      NEW.tenant_photo_url, NEW.id, NEW.agent_id);
  END IF;

  IF NEW.lc_letter_path IS NOT NULL AND btrim(NEW.lc_letter_path) <> '' THEN
    PERFORM public.register_tenant_document(
      NEW.tenant_id, 'lc_letter', COALESCE(NEW.lc_letter_bucket, 'lc-letters'),
      NEW.lc_letter_path, NULL, NEW.id, NEW.agent_id);
  END IF;

  IF NEW.nin_photo_path IS NOT NULL AND btrim(NEW.nin_photo_path) <> '' THEN
    PERFORM public.register_tenant_document(
      NEW.tenant_id, 'national_id', COALESCE(NEW.nin_photo_bucket, 'tenant-ids'),
      NEW.nin_photo_path, NULL, NEW.id, NEW.agent_id);
  END IF;

  PERFORM public.sync_tenant_house_images(
    NEW.tenant_id, NEW.house_image_urls, NEW.id, NEW.agent_id);

  RETURN NEW;
END;
$function$;

-- 4. Private National ID bucket: owner, ops and super admin may read; owner may write.
CREATE POLICY "Tenants upload own national ID"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'tenant-ids' AND (storage.foldername(name))[1] = (auth.uid())::text);

CREATE POLICY "Tenants update own national ID"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'tenant-ids' AND (storage.foldername(name))[1] = (auth.uid())::text);

CREATE POLICY "Tenants and ops view national ID"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'tenant-ids'
    AND (
      (storage.foldername(name))[1] = (auth.uid())::text
      OR public.is_ops_role(auth.uid())
      OR public.has_role(auth.uid(), 'super_admin'::app_role)
    )
  );