-- Backfill: Add 'agent' role to all existing users who don't have it
INSERT INTO public.user_roles (user_id, role)
SELECT p.id, 'agent'::app_role
FROM public.profiles p
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_roles ur 
  WHERE ur.user_id = p.id AND ur.role = 'agent'
)
ON CONFLICT (user_id, role) DO NOTHING;

-- Create trigger function to auto-assign agent role on new user signup
CREATE OR REPLACE FUNCTION public.auto_assign_agent_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'agent'::app_role)
  ON CONFLICT (user_id, role) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS on_profile_created_assign_agent ON public.profiles;

-- Create trigger on profiles table (fires after profile is created)
CREATE TRIGGER on_profile_created_assign_agent
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_assign_agent_role();