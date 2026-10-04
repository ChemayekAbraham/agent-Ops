REVOKE SELECT ON public.vendors FROM anon, authenticated;
GRANT SELECT (id, name, location, phone, created_by, created_at, active, latitude, longitude, category) ON public.vendors TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.vendors TO authenticated;
GRANT ALL ON public.vendors TO service_role;