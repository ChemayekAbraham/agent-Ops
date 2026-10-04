-- Update handle_new_user function to store referrer_id
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Insert profile with referrer_id
  INSERT INTO public.profiles (id, full_name, phone, email, referrer_id)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'phone', ''),
    NEW.email,
    CASE 
      WHEN NEW.raw_user_meta_data->>'referrer_id' IS NOT NULL 
        AND NEW.raw_user_meta_data->>'referrer_id' != 'null'
        AND NEW.raw_user_meta_data->>'referrer_id' != ''
      THEN (NEW.raw_user_meta_data->>'referrer_id')::uuid 
      ELSE NULL 
    END
  );
  
  -- Only insert role if one was provided during signup
  IF NEW.raw_user_meta_data->>'role' IS NOT NULL THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, (NEW.raw_user_meta_data->>'role')::app_role);
  END IF;
  
  RETURN NEW;
END;
$$;