-- Vendor PINs must never be readable by ordinary app users.
-- Column-level privileges are enforced regardless of RLS policy, so we drop
-- the blanket table SELECT and grant SELECT on every column EXCEPT pin/pin_hash.
REVOKE SELECT ON public.vendors FROM authenticated;
REVOKE SELECT ON public.vendors FROM anon;

GRANT SELECT (
  id, name, location, phone, created_by, created_at, active, latitude, longitude, category
) ON public.vendors TO authenticated;

-- Writes are unchanged: managers still insert vendors and set/reset PINs.
GRANT INSERT, UPDATE, DELETE ON public.vendors TO authenticated;
GRANT ALL ON public.vendors TO service_role;