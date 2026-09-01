-- 1. register_tenant_document: revive a retired match instead of leaving it retired.
CREATE OR REPLACE FUNCTION public.register_tenant_document(
  p_tenant_id uuid, p_doc_type text, p_bucket text, p_path text,
  p_public_url text, p_source_rent_request_id uuid, p_uploaded_by uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_next integer;
BEGIN
  IF p_tenant_id IS NULL OR p_doc_type IS NULL THEN
    RETURN NULL;
  END IF;
  IF COALESCE(p_path, p_public_url) IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT id INTO v_id
    FROM public.tenant_documents
   WHERE tenant_id = p_tenant_id
     AND doc_type = p_doc_type
     AND bucket = p_bucket
     AND COALESCE(path, public_url) = COALESCE(p_path, p_public_url);

  IF v_id IS NOT NULL THEN
    -- The same object being submitted again means it is current again.
    UPDATE public.tenant_documents
       SET is_current = true,
           source_rent_request_id = COALESCE(p_source_rent_request_id, source_rent_request_id),
           updated_at = now()
     WHERE id = v_id AND is_current IS DISTINCT FROM true;
    RETURN v_id;
  END IF;

  SELECT COALESCE(MAX(version), 0) + 1 INTO v_next
    FROM public.tenant_documents
   WHERE tenant_id = p_tenant_id AND doc_type = p_doc_type;

  IF p_doc_type IN ('tenant_passport','lc_letter') THEN
    UPDATE public.tenant_documents
       SET is_current = false
     WHERE tenant_id = p_tenant_id AND doc_type = p_doc_type AND is_current;
  END IF;

  INSERT INTO public.tenant_documents
    (tenant_id, doc_type, bucket, path, public_url, source_rent_request_id,
     version, is_current, uploaded_by)
  VALUES
    (p_tenant_id, p_doc_type, p_bucket, p_path, p_public_url, p_source_rent_request_id,
     v_next, true, p_uploaded_by)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- 2. Set-based house image custody: the submitted array IS the current generation.
CREATE OR REPLACE FUNCTION public.sync_tenant_house_images(
  p_tenant_id uuid, p_urls text[], p_source_rent_request_id uuid, p_uploaded_by uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_url text;
  v_clean text[];
  v_count integer := 0;
BEGIN
  IF p_tenant_id IS NULL THEN RETURN 0; END IF;

  SELECT array_agg(u) INTO v_clean
    FROM (SELECT DISTINCT btrim(u) AS u
            FROM unnest(COALESCE(p_urls, '{}'::text[])) AS t(u)
           WHERE NULLIF(btrim(u), '') IS NOT NULL) s;

  -- Nothing submitted: leave existing custody untouched.
  IF v_clean IS NULL OR array_length(v_clean, 1) IS NULL THEN
    RETURN 0;
  END IF;

  -- Retire the previous generation. Rows are never deleted, so the full photo
  -- history stays available for audit.
  UPDATE public.tenant_documents
     SET is_current = false, updated_at = now()
   WHERE tenant_id = p_tenant_id
     AND doc_type = 'house_image'
     AND is_current
     AND COALESCE(path, public_url) <> ALL (v_clean);

  FOREACH v_url IN ARRAY v_clean LOOP
    PERFORM public.register_tenant_document(
      p_tenant_id, 'house_image', 'house-images', NULL, v_url,
      p_source_rent_request_id, p_uploaded_by);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.sync_tenant_house_images(uuid, text[], uuid, uuid) TO service_role;

-- 3. Rent request → tenant_documents sync uses the set-based house image path.
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

  -- The submitted array is the latest generation: older photos are retired
  -- (kept as history) rather than stacking alongside the new ones.
  PERFORM public.sync_tenant_house_images(
    NEW.tenant_id, NEW.house_image_urls, NEW.id, NEW.agent_id);

  RETURN NEW;
END;
$function$;

-- 4. Listing → rent request image sync must never clobber newer photos.
CREATE OR REPLACE FUNCTION public.sync_rent_request_images_from_listing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.image_urls IS NULL OR array_length(NEW.image_urls, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.rent_requests r
     SET house_image_urls = NEW.image_urls
   WHERE (
           r.house_listing_id = NEW.id
           OR (NEW.tenant_id IS NOT NULL AND r.tenant_id = NEW.tenant_id)
         )
     AND COALESCE(r.status, '') NOT IN ('rejected', 'deleted_by_agent', 'cancelled')
     AND COALESCE(r.house_image_urls, '{}') IS DISTINCT FROM NEW.image_urls
     -- A resubmission that happened after this listing was last touched is the
     -- newer truth; an older listing set must not overwrite it.
     AND (
       r.last_resubmitted_at IS NULL
       OR r.last_resubmitted_at <= COALESCE(NEW.updated_at, now())
     );

  RETURN NEW;
END;
$function$;

-- 5. Carry-forward fallback prefers the current generation only.
CREATE OR REPLACE FUNCTION public.carry_forward_tenant_documents()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_photo text;
  v_lc RECORD;
  v_images text[];
BEGIN
  IF NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.tenant_photo_url IS NULL OR btrim(NEW.tenant_photo_url) = '' THEN
    SELECT COALESCE(public_url, path) INTO v_photo
      FROM public.tenant_documents
     WHERE tenant_id = NEW.tenant_id AND doc_type = 'tenant_passport'
     ORDER BY is_current DESC, version DESC, created_at DESC
     LIMIT 1;
    IF v_photo IS NOT NULL THEN
      NEW.tenant_photo_url := v_photo;
    END IF;
  END IF;

  IF NEW.lc_letter_path IS NULL OR btrim(NEW.lc_letter_path) = '' THEN
    SELECT bucket, path INTO v_lc
      FROM public.tenant_documents
     WHERE tenant_id = NEW.tenant_id AND doc_type = 'lc_letter' AND path IS NOT NULL
     ORDER BY is_current DESC, version DESC, created_at DESC
     LIMIT 1;
    IF v_lc.path IS NOT NULL THEN
      NEW.lc_letter_path := v_lc.path;
      NEW.lc_letter_bucket := v_lc.bucket;
    END IF;
  END IF;

  IF NEW.house_image_urls IS NULL OR array_length(NEW.house_image_urls, 1) IS NULL THEN
    SELECT array_agg(u) INTO v_images
      FROM (
        SELECT DISTINCT COALESCE(public_url, path) AS u
          FROM public.tenant_documents
         WHERE tenant_id = NEW.tenant_id
           AND doc_type = 'house_image'
           AND is_current
         LIMIT 10
      ) s
     WHERE u IS NOT NULL;
    IF v_images IS NULL OR array_length(v_images, 1) IS NULL THEN
      SELECT array_agg(u) INTO v_images
        FROM (
          SELECT DISTINCT COALESCE(public_url, path) AS u
            FROM public.tenant_documents
           WHERE tenant_id = NEW.tenant_id AND doc_type = 'house_image'
           LIMIT 10
        ) s
       WHERE u IS NOT NULL;
    END IF;
    IF v_images IS NOT NULL AND array_length(v_images, 1) > 0 THEN
      NEW.house_image_urls := v_images;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;