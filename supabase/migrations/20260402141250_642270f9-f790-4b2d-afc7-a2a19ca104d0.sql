
CREATE TABLE public.service_centre_setups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  photo_url TEXT NOT NULL,
  latitude NUMERIC NOT NULL,
  longitude NUMERIC NOT NULL,
  location_name TEXT,
  agent_name TEXT NOT NULL,
  agent_phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  verified_by UUID,
  verified_at TIMESTAMPTZ,
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.service_centre_setups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents can insert own service centre setups"
ON public.service_centre_setups FOR INSERT TO authenticated
WITH CHECK (agent_id = auth.uid());

CREATE POLICY "Agents can view own service centre setups"
ON public.service_centre_setups FOR SELECT TO authenticated
USING (agent_id = auth.uid());

CREATE POLICY "Staff can view all service centre setups"
ON public.service_centre_setups FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
    AND role IN ('manager', 'coo', 'cfo', 'cto', 'super_admin', 'operations')
  )
);

CREATE POLICY "Staff can update service centre setups"
ON public.service_centre_setups FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
    AND role IN ('manager', 'coo', 'cfo', 'cto', 'super_admin', 'operations')
  )
);

INSERT INTO storage.buckets (id, name, public) VALUES ('service-centre-photos', 'service-centre-photos', true);

CREATE POLICY "Authenticated users can upload service centre photos"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'service-centre-photos');

CREATE POLICY "Anyone can view service centre photos"
ON storage.objects FOR SELECT TO public
USING (bucket_id = 'service-centre-photos');
