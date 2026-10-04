CREATE TABLE IF NOT EXISTS public.infrastructure_settings (
  id boolean PRIMARY KEY DEFAULT true,
  current_instance text NOT NULL DEFAULT 'mini'
    CHECK (current_instance IN ('mini', 'small', 'medium', 'large')),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT infrastructure_settings_singleton CHECK (id = true)
);

INSERT INTO public.infrastructure_settings (id, current_instance)
VALUES (true, 'mini')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.infrastructure_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "infrastructure_settings_read" ON public.infrastructure_settings;
CREATE POLICY "infrastructure_settings_read"
ON public.infrastructure_settings
FOR SELECT
TO authenticated
USING (true);

DROP POLICY IF EXISTS "infrastructure_settings_update" ON public.infrastructure_settings;
CREATE POLICY "infrastructure_settings_update"
ON public.infrastructure_settings
FOR UPDATE
TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'cto')
)
WITH CHECK (
  public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'cto')
);