-- Enable realtime for profiles table so managers see new tenants instantly
ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;