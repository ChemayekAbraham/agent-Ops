DO $fm1guard_outer$
DECLARE
  s text := $fm1guard$-- Food M1 — meal photos.
--
-- NOT APPLIED TO PRODUCTION. Applies after 20261012120000.
--
-- The Food Coordinator can now give a meal a photo. Nothing here touches money,
-- wallets, the ledger, payment status or any non-Food table's data.
--
-- STORAGE. One dedicated, PRIVATE bucket, `food-meal-images`:
--   * no public URL: a photo is shown through a short-lived signed URL, which
--     Storage issues only to a caller its SELECT policy admits;
--   * READ: the active Food Coordinator (any photo), and a canteen user only
--     for the photo of a PUBLISHED meal (food_meal_photo_readable). A draft or
--     archived meal's photo is not readable by employees even by exact name;
--   * files: at most 2 MB (bucket limit); JPEG, PNG or WebP names only (upload policy);
--   * WRITE: the ACTIVE Food Coordinator only (a backup holder cannot), and only
--     under a server-shaped name `meals/<uuid>.<ext>`. Uploads are never
--     overwritten or deleted through the API: a new photo is a new file, so a
--     photo that once appeared on a menu cannot be silently swapped.
-- A signed URL is a bearer link: whoever holds it can fetch the file until it
-- expires. Privacy here means "no URL without a staff login", not more.
-- The storage policies below are scoped to this bucket by their own condition,
-- so every other bucket's access is exactly as before.
--
-- MEAL RECORD. food_set_meal_image() is the ONLY way to set or clear
-- food_meals.image_path: it checks the name and that the object exists, and
-- audits the change. food_upsert_meal() no longer accepts a photo at all, and a
-- CHECK keeps any other value out of the column.
--
-- ROLLBACK: DROP FUNCTION food_set_meal_image(uuid,text,text) and
-- food_meal_photo_readable(text); DROP the food_meal_images_* policies on
-- storage.objects; DROP CONSTRAINT food_meals_image_path_shape; re-run the
-- food_upsert_meal definition from 20261009130001 followed by its ALTER ...
-- SET search_path from 20261012120000. The bucket and any uploaded files can
-- then be removed by an administrator. food_meals.image_path values survive and
-- simply stop resolving.

-- ═══════════════ bucket ═══════════════
-- The bucket is NOT created here. Lovable Cloud creates buckets only through its
-- storage tool, which rejects SQL writes to storage.buckets. Before this file
-- runs, create it with that tool: name `food-meal-images`, public = false,
-- file_size_limit = 2MB. This file then refuses to apply (rolling back
-- entirely) unless that bucket exists, is PRIVATE and caps files at 2 MB or
-- less. File types are enforced by the upload policy below (server-shaped
-- .jpg/.jpeg/.png/.webp name only); if the bucket also restricts MIME types,
-- it may allow only JPEG, PNG and WebP.
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'food-meal-images') THEN
    RAISE EXCEPTION 'food: create the private bucket food-meal-images (2MB limit) with the storage tool before this migration';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets
                  WHERE id = 'food-meal-images' AND public IS FALSE
                    AND file_size_limit IS NOT NULL AND file_size_limit BETWEEN 1 AND 2097152
                    AND (allowed_mime_types IS NULL
                         OR allowed_mime_types <@ ARRAY['image/jpeg', 'image/png', 'image/webp'])) THEN
    RAISE EXCEPTION 'food: bucket food-meal-images must be private with a file size limit of at most 2MB; resolve with the storage tool';
  END IF;
END
$chk$;

-- ═══════════════ the only values image_path may hold ═══════════════
-- NOT VALID: rows written before this migration are not re-checked (production
-- has none); every new or updated row is.
ALTER TABLE public.food_meals
  ADD CONSTRAINT food_meals_image_path_shape
  CHECK (image_path IS NULL
         OR image_path ~ '^meals/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$')
  NOT VALID;

-- ═══════════════ who may read ═══════════════
-- Self-only: answers for the caller. Definer so it can see food_meals (RLS
-- lets only the coordinator read that table) and the canteen-eligibility rule.
CREATE FUNCTION public.food_meal_photo_readable(p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN false
    WHEN public.is_active_food_coordinator(auth.uid()) THEN true
    ELSE public.food_is_canteen_user(auth.uid())
         AND EXISTS (SELECT 1 FROM public.food_meals m
                      WHERE m.image_path = p_name AND m.status = 'published')
  END
$$;
REVOKE ALL ON FUNCTION public.food_meal_photo_readable(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.food_meal_photo_readable(text) TO authenticated;

-- Signed URLs (and the upload call itself) are issued only for rows this admits.
CREATE POLICY food_meal_images_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'food-meal-images' AND public.food_meal_photo_readable(name));

-- ═══════════════ who may write ═══════════════
-- Upload: active coordinator, this bucket, server-shaped name only.
CREATE POLICY food_meal_images_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'food-meal-images'
    AND name ~ '^meals/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$'
    AND public.is_active_food_coordinator(auth.uid()));

-- No UPDATE and no DELETE policy: uploads are immutable through the API.

-- ═══════════════ set or clear a meal's photo ═══════════════
CREATE FUNCTION public.food_set_meal_image(
  p_meal_id uuid, p_image_path text, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor uuid := public.food_require_active_coordinator();
        v_before jsonb; v_path text := nullif(btrim(p_image_path), '');
BEGIN
  SELECT to_jsonb(m) INTO v_before FROM public.food_meals m WHERE m.id = p_meal_id FOR UPDATE;
  IF v_before IS NULL THEN RAISE EXCEPTION 'Meal not found' USING ERRCODE='P0002'; END IF;
  IF (v_before->>'status') = 'archived' THEN
    RAISE EXCEPTION 'Archived meals cannot be edited' USING ERRCODE='22023'; END IF;

  IF v_path IS NOT NULL THEN
    IF v_path !~ '^meals/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$' THEN
      RAISE EXCEPTION 'That is not a meal photo upload' USING ERRCODE='22023'; END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects
                    WHERE bucket_id = 'food-meal-images' AND name = v_path) THEN
      RAISE EXCEPTION 'The photo has not been uploaded' USING ERRCODE='P0002'; END IF;
  END IF;

  UPDATE public.food_meals SET image_path = v_path, updated_at = now() WHERE id = p_meal_id;

  PERFORM public.food_audit_write('meal', p_meal_id,
    CASE WHEN v_path IS NULL THEN 'photo_removed' ELSE 'photo_set' END,
    jsonb_build_object('image_path', v_before->>'image_path'),
    jsonb_build_object('image_path', v_path), p_reason, v_actor);

  RETURN jsonb_build_object('meal_id', p_meal_id, 'image_path', v_path);
END $$;

REVOKE ALL ON FUNCTION public.food_set_meal_image(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.food_set_meal_image(uuid,text,text) TO authenticated;

-- ═══════════════ food_upsert_meal no longer takes a photo ═══════════════
-- Same signature and grants (CREATE OR REPLACE keeps them). The body is the
-- 20261009130001 definition with one change: p_image_path must be NULL, so the
-- name, existence and audit checks of food_set_meal_image cannot be bypassed.
-- An update leaves the stored photo exactly as it was.
CREATE OR REPLACE FUNCTION public.food_upsert_meal(
  p_meal_id uuid, p_name text, p_description text, p_category_id uuid,
  p_price_ugx numeric, p_image_path text DEFAULT NULL, p_reason text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor uuid := public.food_require_active_coordinator();
        v_before jsonb; v_id uuid;
BEGIN
  IF p_image_path IS NOT NULL THEN
    RAISE EXCEPTION 'Meal photos are set with food_set_meal_image, not here' USING ERRCODE='22023'; END IF;
  IF p_name IS NULL OR length(btrim(p_name))=0 THEN
    RAISE EXCEPTION 'Meal name is required' USING ERRCODE='22023'; END IF;
  IF p_price_ugx IS NULL OR p_price_ugx < 0 THEN
    RAISE EXCEPTION 'Price must be zero or more' USING ERRCODE='22023'; END IF;

  IF p_meal_id IS NULL THEN
    INSERT INTO public.food_meals (name, description, category_id, price_ugx, image_path, created_by)
    VALUES (btrim(p_name), p_description, p_category_id, round(p_price_ugx,2), NULL, v_actor)
    RETURNING id INTO v_id;
    PERFORM public.food_audit_write('meal', v_id, 'created', NULL,
      jsonb_build_object('name',p_name,'price_ugx',p_price_ugx), p_reason, v_actor);
  ELSE
    SELECT to_jsonb(m) INTO v_before FROM public.food_meals m WHERE m.id=p_meal_id;
    IF v_before IS NULL THEN RAISE EXCEPTION 'Meal not found' USING ERRCODE='P0002'; END IF;
    IF (v_before->>'status')='archived' THEN
      RAISE EXCEPTION 'Archived meals cannot be edited' USING ERRCODE='22023'; END IF;
    UPDATE public.food_meals SET name=btrim(p_name), description=p_description,
           category_id=p_category_id, price_ugx=round(p_price_ugx,2), updated_at=now()
     WHERE id=p_meal_id RETURNING id INTO v_id;
    PERFORM public.food_audit_write('meal', v_id, 'updated', v_before,
      (SELECT to_jsonb(m) FROM public.food_meals m WHERE m.id=v_id), p_reason, v_actor);
  END IF;
  RETURN v_id;
END $$;
$fm1guard$;
  h text := encode(sha256(convert_to(s, 'UTF8')), 'hex');
BEGIN
  IF h <> 'baac302602b53fa2ca41bb150a8b55eba6bada4e0d15c1ad449b2704cc3c6378' THEN
    RAISE EXCEPTION 'food m1 guard: 20261013120001 checksum mismatch, got %', h;
  END IF;
  EXECUTE s;
END
$fm1guard_outer$;