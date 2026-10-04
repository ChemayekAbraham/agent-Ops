DROP POLICY IF EXISTS "Anyone can view active vendors" ON public.vendors;

CREATE POLICY "Authenticated users can view active vendors"
ON public.vendors
FOR SELECT
TO authenticated
USING (active = true);

-- anon loses all access to the table
REVOKE ALL ON public.vendors FROM anon;

-- Column-level lockdown: authenticated may never read pin / pin_hash
REVOKE SELECT ON public.vendors FROM authenticated;
GRANT SELECT (
  id, name, location, phone, created_by, created_at,
  active, latitude, longitude, category
) ON public.vendors TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.vendors TO authenticated;

GRANT ALL ON public.vendors TO service_role;