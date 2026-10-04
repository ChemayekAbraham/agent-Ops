
-- Fix security definer on the view
ALTER VIEW public.manager_profiles SET (security_invoker = on);
