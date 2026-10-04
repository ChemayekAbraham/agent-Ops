CREATE OR REPLACE FUNCTION public.agent_set_own_contact_email(p_email text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(p_email));
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'Email is required';
  END IF;
  -- Basic format validation
  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'Please enter a valid email address';
  END IF;
  -- Reject the synthetic phone-based placeholder domain
  IF v_email ILIKE '%welile.user' THEN
    RAISE EXCEPTION 'Please enter your real email address';
  END IF;

  UPDATE public.profiles
     SET email = v_email,
         updated_at = now()
   WHERE id = v_uid;

  RETURN v_email;
END;
$$;

GRANT EXECUTE ON FUNCTION public.agent_set_own_contact_email(text) TO authenticated;