-- Column-level lockdown of vendor authentication secrets.
-- RLS cannot restrict columns, so revoke read access to pin/pin_hash and
-- re-grant every other column explicitly.

REVOKE SELECT ON public.vendors FROM authenticated;
REVOKE SELECT ON public.vendors FROM anon;

GRANT SELECT (id, name, location, phone, created_by, created_at, active, latitude, longitude, category)
  ON public.vendors TO authenticated;

-- Managers may still write a PIN (RLS still gates who), but never read it back.
GRANT INSERT, UPDATE, DELETE ON public.vendors TO authenticated;

GRANT ALL ON public.vendors TO service_role;
