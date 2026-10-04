
-- Enable pgcrypto for password hashing
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Staff access passwords (separate from auth passwords)
CREATE TABLE public.staff_access_passwords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  password_hash text NOT NULL,
  must_change boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.staff_access_passwords ENABLE ROW LEVEL SECURITY;

-- No direct client access - only through RPCs
CREATE POLICY "No direct access" ON public.staff_access_passwords
  FOR SELECT TO authenticated USING (false);

-- RPC: Verify staff access password
CREATE OR REPLACE FUNCTION public.verify_staff_access_password(p_user_id uuid, p_password text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_record staff_access_passwords%ROWTYPE;
BEGIN
  SELECT * INTO v_record FROM staff_access_passwords WHERE user_id = p_user_id;
  
  IF NOT FOUND THEN
    -- No password set yet, check against default
    IF p_password = 'WelileManager' THEN
      INSERT INTO staff_access_passwords (user_id, password_hash, must_change)
      VALUES (p_user_id, crypt('WelileManager', gen_salt('bf')), true);
      RETURN jsonb_build_object('valid', true, 'must_change', true);
    END IF;
    RETURN jsonb_build_object('valid', false, 'must_change', false);
  END IF;
  
  IF v_record.password_hash = crypt(p_password, v_record.password_hash) THEN
    RETURN jsonb_build_object('valid', true, 'must_change', v_record.must_change);
  END IF;
  
  RETURN jsonb_build_object('valid', false, 'must_change', false);
END;
$$;

-- RPC: Set new staff access password
CREATE OR REPLACE FUNCTION public.set_staff_access_password(p_user_id uuid, p_new_password text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO staff_access_passwords (user_id, password_hash, must_change)
  VALUES (p_user_id, crypt(p_new_password, gen_salt('bf')), false)
  ON CONFLICT (user_id) DO UPDATE
  SET password_hash = crypt(p_new_password, gen_salt('bf')),
      must_change = false,
      updated_at = now();
  RETURN true;
END;
$$;

-- Revert the must_change_password flag on profiles (undo previous change)
UPDATE public.profiles SET must_change_password = false WHERE must_change_password = true;
