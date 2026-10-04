-- Seed the rent access limit params row (only this single config row)
INSERT INTO public.system_config (key, value)
VALUES (
  'rent_access_limit_params',
  jsonb_build_object(
    'paid_increment_ugx', 10000,
    'missed_decrement_ugx', 7000,
    'max_limit_ugx', 30000000
  )
)
ON CONFLICT (key) DO NOTHING;

-- Allow any authenticated user to read JUST this single config row,
-- so the tenant profile card can fetch the live values.
DROP POLICY IF EXISTS "Authenticated read rent_access_limit_params" ON public.system_config;
CREATE POLICY "Authenticated read rent_access_limit_params"
ON public.system_config
FOR SELECT
TO authenticated
USING (key = 'rent_access_limit_params');

-- Allow manager / super_admin / cfo / ceo to update this single config row.
DROP POLICY IF EXISTS "Executives update rent_access_limit_params" ON public.system_config;
CREATE POLICY "Executives update rent_access_limit_params"
ON public.system_config
FOR UPDATE
TO authenticated
USING (
  key = 'rent_access_limit_params'
  AND (
    public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
  )
)
WITH CHECK (
  key = 'rent_access_limit_params'
  AND (
    public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
  )
);
