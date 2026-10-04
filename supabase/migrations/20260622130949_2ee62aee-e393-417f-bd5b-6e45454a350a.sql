CREATE TABLE public.managed_locations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  location_type TEXT NOT NULL DEFAULT 'town',
  district TEXT,
  region TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.managed_locations TO authenticated;
GRANT ALL ON public.managed_locations TO service_role;

ALTER TABLE public.managed_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Signed-in users can view locations"
ON public.managed_locations FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Ops can create locations"
ON public.managed_locations FOR INSERT
TO authenticated
WITH CHECK (public.is_ops_role(auth.uid()));

CREATE POLICY "Ops can update locations"
ON public.managed_locations FOR UPDATE
TO authenticated
USING (public.is_ops_role(auth.uid()))
WITH CHECK (public.is_ops_role(auth.uid()));

CREATE TRIGGER update_managed_locations_updated_at
BEFORE UPDATE ON public.managed_locations
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_managed_locations_active ON public.managed_locations (active);
CREATE INDEX idx_managed_locations_district ON public.managed_locations (district);