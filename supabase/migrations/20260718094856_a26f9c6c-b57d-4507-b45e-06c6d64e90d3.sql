
CREATE OR REPLACE FUNCTION public.is_phone_available(p_phone text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm text;
  v_uid uuid := auth.uid();
  v_exists boolean;
BEGIN
  v_norm := normalize_ug_phone(p_phone);
  IF v_norm IS NULL THEN
    RETURN false;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE normalize_ug_phone(phone) = v_norm
      AND (v_uid IS NULL OR id <> v_uid)
  ) INTO v_exists;
  RETURN NOT v_exists;
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_phone_available(text) TO authenticated;
