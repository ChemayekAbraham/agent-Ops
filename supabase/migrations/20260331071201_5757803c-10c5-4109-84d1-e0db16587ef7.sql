DROP FUNCTION IF EXISTS public.verify_staff_access_password(uuid, text);
DROP FUNCTION IF EXISTS public.set_staff_access_password(uuid, text);

CREATE FUNCTION public.verify_staff_access_password(p_user_id uuid, p_password text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_record public.staff_access_passwords%ROWTYPE;
BEGIN
  SELECT *
  INTO v_record
  FROM public.staff_access_passwords
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    IF p_password = 'WelileManager' THEN
      INSERT INTO public.staff_access_passwords (user_id, password_hash, must_change)
      VALUES (
        p_user_id,
        extensions.crypt('WelileManager', extensions.gen_salt('bf')),
        true
      )
      ON CONFLICT (user_id) DO NOTHING;

      RETURN jsonb_build_object('valid', true, 'must_change', true);
    END IF;

    RETURN jsonb_build_object('valid', false, 'must_change', false);
  END IF;

  IF v_record.password_hash = extensions.crypt(p_password, v_record.password_hash) THEN
    RETURN jsonb_build_object('valid', true, 'must_change', v_record.must_change);
  END IF;

  RETURN jsonb_build_object('valid', false, 'must_change', false);
END;
$$;

CREATE FUNCTION public.set_staff_access_password(p_user_id uuid, p_new_password text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.staff_access_passwords (user_id, password_hash, must_change)
  VALUES (
    p_user_id,
    extensions.crypt(p_new_password, extensions.gen_salt('bf')),
    false
  )
  ON CONFLICT (user_id)
  DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    must_change = false,
    updated_at = now();

  RETURN true;
END;
$$;