CREATE OR REPLACE FUNCTION public.log_verification_selfie_crop(
  p_selfie_path text,
  p_crop_path text,
  p_avatar_url text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  IF coalesce(btrim(p_selfie_path), '') = '' THEN
    RAISE EXCEPTION 'Selfie path is required';
  END IF;

  -- Both objects must live in the caller's own storage folder.
  IF split_part(p_selfie_path, '/', 1) <> v_uid::text
     OR (coalesce(btrim(p_crop_path), '') <> ''
         AND split_part(p_crop_path, '/', 1) <> v_uid::text) THEN
    RAISE EXCEPTION 'Photo paths must belong to the signed-in user';
  END IF;

  INSERT INTO public.audit_logs (
    user_id, action_type, action, table_name, record_id, reason, new_values, metadata
  ) VALUES (
    v_uid,
    'verification_selfie_stored',
    'Stored verification selfie and set cropped profile picture',
    'profiles',
    v_uid::text,
    'Verification selfie archived; cropped copy used as profile picture',
    jsonb_build_object(
      'original_selfie_path', p_selfie_path,
      'profile_crop_path', nullif(btrim(p_crop_path), ''),
      'avatar_url', nullif(btrim(p_avatar_url), '')
    ),
    jsonb_build_object('source', 'identity_photo_capture', 'logged_at', now())
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.log_verification_selfie_crop(text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.log_verification_selfie_crop(text, text, text) TO authenticated;
