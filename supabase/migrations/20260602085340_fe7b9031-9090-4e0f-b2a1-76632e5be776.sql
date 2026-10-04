CREATE TABLE public.map_config (
  id boolean PRIMARY KEY DEFAULT true,
  browser_api_key text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT map_config_singleton CHECK (id)
);

-- Seed the single config row.
INSERT INTO public.map_config (id, browser_api_key) VALUES (true, NULL);

GRANT SELECT ON public.map_config TO anon;
GRANT SELECT, INSERT, UPDATE ON public.map_config TO authenticated;
GRANT ALL ON public.map_config TO service_role;

ALTER TABLE public.map_config ENABLE ROW LEVEL SECURITY;

-- The browser key is a referrer-restricted public key; safe for everyone to read
-- so the map can load at app startup before auth.
CREATE POLICY "Anyone can read map config"
ON public.map_config
FOR SELECT
TO anon, authenticated
USING (true);

-- Only managers may set/change the custom Maps key.
CREATE POLICY "Managers can insert map config"
ON public.map_config
FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Managers can update map config"
ON public.map_config
FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'manager'))
WITH CHECK (public.has_role(auth.uid(), 'manager'));