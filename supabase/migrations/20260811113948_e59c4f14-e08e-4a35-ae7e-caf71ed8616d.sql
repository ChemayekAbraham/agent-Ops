CREATE OR REPLACE FUNCTION public.service_mark_landlord_verified(
  p_landlord_id uuid,
  p_manager_id uuid,
  p_source text DEFAULT 'house_verification'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_changed boolean := false;
BEGIN
  IF p_landlord_id IS NULL THEN RETURN false; END IF;

  PERFORM set_config('landlord_verification.sync_authorized', 'true', true);

  UPDATE public.landlords
  SET verification_status = 'verified',
      verified = true,
      verified_at = COALESCE(verified_at, now()),
      verified_by = COALESCE(verified_by, p_manager_id),
      verification_source = COALESCE(NULLIF(btrim(p_source), ''), 'house_verification'),
      verification_reason = COALESCE(verification_reason, 'Auto-verified when the landlord''s house listing was verified by Landlord Operations')
  WHERE id = p_landlord_id
    AND COALESCE(verified, false) = false;

  v_changed := FOUND;

  PERFORM set_config('landlord_verification.sync_authorized', 'false', true);

  RETURN v_changed;
END;
$$;

REVOKE ALL ON FUNCTION public.service_mark_landlord_verified(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.service_mark_landlord_verified(uuid, uuid, text) TO service_role;