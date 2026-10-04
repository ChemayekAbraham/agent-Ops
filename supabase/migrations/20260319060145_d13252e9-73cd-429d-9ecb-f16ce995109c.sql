
-- Property viewings pipeline table
CREATE TABLE public.property_viewings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  house_listing_id UUID REFERENCES public.house_listings(id) ON DELETE CASCADE NOT NULL,
  tenant_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  landlord_id UUID REFERENCES public.landlords(id),
  scheduled_date DATE,
  scheduled_time TEXT,
  status TEXT NOT NULL DEFAULT 'matched',
  agent_confirmed BOOLEAN DEFAULT FALSE,
  tenant_confirmed BOOLEAN DEFAULT FALSE,
  landlord_confirmed BOOLEAN DEFAULT FALSE,
  agent_confirmed_at TIMESTAMPTZ,
  tenant_confirmed_at TIMESTAMPTZ,
  landlord_confirmed_at TIMESTAMPTZ,
  confirmation_count INT GENERATED ALWAYS AS (
    (CASE WHEN agent_confirmed THEN 1 ELSE 0 END) +
    (CASE WHEN tenant_confirmed THEN 1 ELSE 0 END) +
    (CASE WHEN landlord_confirmed THEN 1 ELSE 0 END)
  ) STORED,
  agent_checkin_lat DOUBLE PRECISION,
  agent_checkin_lng DOUBLE PRECISION,
  notes TEXT,
  assigned_by UUID,
  sms_sent BOOLEAN DEFAULT FALSE,
  confirmation_sms_sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_property_viewings_status ON public.property_viewings(status);
CREATE INDEX idx_property_viewings_tenant ON public.property_viewings(tenant_id);
CREATE INDEX idx_property_viewings_agent ON public.property_viewings(agent_id);
CREATE INDEX idx_property_viewings_house ON public.property_viewings(house_listing_id);

-- RLS
ALTER TABLE public.property_viewings ENABLE ROW LEVEL SECURITY;

-- Managers and internal staff can do everything
CREATE POLICY "Internal staff full access on property_viewings"
ON public.property_viewings
FOR ALL
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager') OR
  public.has_role(auth.uid(), 'super_admin') OR
  public.has_role(auth.uid(), 'coo') OR
  public.has_role(auth.uid(), 'operations')
)
WITH CHECK (
  public.has_role(auth.uid(), 'manager') OR
  public.has_role(auth.uid(), 'super_admin') OR
  public.has_role(auth.uid(), 'coo') OR
  public.has_role(auth.uid(), 'operations')
);

-- Agents can view their own viewings
CREATE POLICY "Agents view own viewings"
ON public.property_viewings
FOR SELECT
TO authenticated
USING (agent_id = auth.uid());

-- Tenants can view their own viewings
CREATE POLICY "Tenants view own viewings"
ON public.property_viewings
FOR SELECT
TO authenticated
USING (tenant_id = auth.uid());

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.property_viewings;
