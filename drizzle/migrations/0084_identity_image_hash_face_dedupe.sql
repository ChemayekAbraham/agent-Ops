ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS selfie_image_hash text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS id_image_hash text;

CREATE INDEX IF NOT EXISTS profiles_selfie_image_hash_idx
  ON public.profiles (selfie_image_hash) WHERE selfie_image_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS profiles_id_image_hash_idx
  ON public.profiles (id_image_hash) WHERE id_image_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION public.record_identity_image_hashes(
  p_selfie_hash text DEFAULT NULL,
  p_id_hash text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_selfie text := nullif(btrim(coalesce(p_selfie_hash, '')), '');
  v_id text := nullif(btrim(coalesce(p_id_hash, '')), '');
  v_face_clash uuid;
  v_id_clash uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in first.';
  END IF;

  UPDATE public.profiles
     SET selfie_image_hash = coalesce(v_selfie, selfie_image_hash),
         id_image_hash = coalesce(v_id, id_image_hash)
   WHERE id = v_uid;

  IF v_selfie IS NOT NULL THEN
    SELECT b.id INTO v_face_clash
      FROM public.profiles b
     WHERE b.id <> v_uid AND b.selfie_image_hash = v_selfie
     ORDER BY b.created_at, b.id
     LIMIT 1;
  END IF;

  IF v_id IS NOT NULL THEN
    SELECT b.id INTO v_id_clash
      FROM public.profiles b
     WHERE b.id <> v_uid AND b.id_image_hash = v_id
     ORDER BY b.created_at, b.id
     LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'face_duplicate_of', v_face_clash,
    'id_photo_duplicate_of', v_id_clash
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_identity_image_hashes(text, text) TO authenticated;

CREATE OR REPLACE VIEW public.v_identity_double_users AS
WITH p AS (
  SELECT profiles.id,
         profiles.created_at,
         public.normalize_national_id_fuzzy(profiles.national_id) AS nid,
         "right"(regexp_replace(COALESCE(profiles.phone, ''), '[^0-9]', '', 'g'), 9) AS ph9,
         nullif(btrim(coalesce(profiles.selfie_image_hash, '')), '') AS face,
         nullif(btrim(coalesce(profiles.id_image_hash, '')), '') AS idimg
  FROM public.profiles
), ver AS (
  SELECT DISTINCT d.user_id
  FROM public.payout_destination_verifications d
  WHERE d.status = 'verified'
), nid_verified AS (
  SELECT a.id AS user_id,
         'national_id'::text AS kind,
         (SELECT b.id FROM p b JOIN ver vb ON vb.user_id = b.id
           WHERE b.nid = a.nid AND b.id <> a.id ORDER BY b.created_at, b.id LIMIT 1) AS first_id,
         0 AS pref
  FROM p a
  WHERE length(COALESCE(a.nid, '')) >= 6
    AND NOT EXISTS (SELECT 1 FROM ver va WHERE va.user_id = a.id)
    AND EXISTS (SELECT 1 FROM p b JOIN ver vb ON vb.user_id = b.id
                 WHERE b.nid = a.nid AND b.id <> a.id)
), face_rank AS (
  SELECT p.id,
         first_value(p.id) OVER w AS first_id,
         row_number() OVER w AS rn
  FROM p
  WHERE p.face IS NOT NULL
  WINDOW w AS (PARTITION BY p.face ORDER BY p.created_at, p.id)
), idimg_rank AS (
  SELECT p.id,
         first_value(p.id) OVER w AS first_id,
         row_number() OVER w AS rn
  FROM p
  WHERE p.idimg IS NOT NULL
  WINDOW w AS (PARTITION BY p.idimg ORDER BY p.created_at, p.id)
), nid_rank AS (
  SELECT p.id,
         first_value(p.id) OVER w AS first_id,
         row_number() OVER w AS rn
  FROM p
  WHERE length(COALESCE(p.nid, '')) >= 6
  WINDOW w AS (PARTITION BY p.nid ORDER BY p.created_at, p.id)
), ph_rank AS (
  SELECT p.id,
         first_value(p.id) OVER w AS first_id,
         row_number() OVER w AS rn
  FROM p
  WHERE length(COALESCE(p.ph9, '')) >= 9
  WINDOW w AS (PARTITION BY p.ph9 ORDER BY p.created_at, p.id)
), u AS (
  SELECT user_id, kind, first_id, pref FROM nid_verified
  UNION ALL
  SELECT face_rank.id, 'face'::text, face_rank.first_id, 1 FROM face_rank WHERE face_rank.rn > 1
  UNION ALL
  SELECT idimg_rank.id, 'id_photo'::text, idimg_rank.first_id, 2 FROM idimg_rank WHERE idimg_rank.rn > 1
  UNION ALL
  SELECT nid_rank.id, 'national_id'::text, nid_rank.first_id, 3 FROM nid_rank WHERE nid_rank.rn > 1
  UNION ALL
  SELECT ph_rank.id, 'phone'::text, ph_rank.first_id, 4 FROM ph_rank WHERE ph_rank.rn > 1
)
SELECT DISTINCT ON (user_id) user_id, kind, first_id AS first_user_id
FROM u
ORDER BY user_id, pref;