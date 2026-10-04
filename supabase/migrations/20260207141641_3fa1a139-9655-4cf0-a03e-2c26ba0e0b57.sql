
-- Create a view that joins user_roles and profiles for managers in a single query
CREATE OR REPLACE VIEW public.manager_profiles AS
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
