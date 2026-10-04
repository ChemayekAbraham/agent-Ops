-- Update auto_assign_agent_role to respect role-specific accounts
-- Supporters registered by agents should ONLY get the supporter role
CREATE OR REPLACE FUNCTION public.auto_assign_agent_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_intended_role text;
BEGIN
  -- Check if the user was created with a specific intended role via referrer
  SELECT raw_user_meta_data->>'role' INTO v_intended_role
  FROM auth.users
  WHERE id = NEW.id;

  -- If the intended role is 'supporter', only assign supporter
  IF v_intended_role = 'supporter' THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'supporter')
    ON CONFLICT (user_id, role) DO NOTHING;
  ELSE
    -- Default: assign all 4 roles for regular signups
    INSERT INTO public.user_roles (user_id, role)
    VALUES 
      (NEW.id, 'tenant'),
      (NEW.id, 'agent'),
      (NEW.id, 'supporter'),
      (NEW.id, 'landlord')
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
  
  RETURN NEW;
END;
$$;