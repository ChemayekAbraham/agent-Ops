REVOKE SELECT ON public.vendors FROM authenticated;
REVOKE SELECT ON public.vendors FROM anon;
GRANT SELECT (id, name, location, phone, created_by, created_at, active, latitude, longitude, category) ON public.vendors TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendors TO authenticated;
REVOKE SELECT (pin, pin_hash) ON public.vendors FROM authenticated;
GRANT ALL ON public.vendors TO service_role;