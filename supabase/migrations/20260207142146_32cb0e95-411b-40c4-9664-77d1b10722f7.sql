
-- Create a secure function that returns manager profiles bypassing RLS
-- This is safe because it only returns limited profile data for managers
CREATE OR REPLACE FUNCTION public.get_manager_profiles()
RETURNS TABLE (
  user_id uuid,
  full_name text,
  email text,
  phone text,
  avatar_url text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT 
    p.id as user_id,
    p.full_name,
    p.email,
    p.phone,
    p.avatar_url
  FROM public.profiles p
  INNER JOIN public.user_roles ur ON ur.user_id = p.id
  WHERE ur.role = 'manager'
    AND (ur.enabled IS NULL OR ur.enabled = true)
  ORDER BY p.full_name;
$$;
