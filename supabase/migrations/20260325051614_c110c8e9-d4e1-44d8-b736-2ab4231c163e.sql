
-- Funder visits table: agents log GPS check-ins when visiting no-smartphone funders
CREATE TABLE public.funder_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.profiles(id),
  funder_id UUID NOT NULL REFERENCES public.profiles(id),
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  accuracy DOUBLE PRECISION,
  location_name TEXT,
  notes TEXT,
  visit_type TEXT NOT NULL DEFAULT 'routine' CHECK (visit_type IN ('routine', 'collection', 'statement_delivery', 'dispute_resolution')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.funder_visits ENABLE ROW LEVEL SECURITY;

-- Agents can view and insert their own visits
CREATE POLICY "Agents can view own funder visits"
  ON public.funder_visits FOR SELECT TO authenticated
  USING (agent_id = auth.uid());

CREATE POLICY "Agents can insert funder visits"
  ON public.funder_visits FOR INSERT TO authenticated
  WITH CHECK (agent_id = auth.uid());

-- Managers/COO/CFO can view all
CREATE POLICY "Staff can view all funder visits"
  ON public.funder_visits FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'manager') OR
    public.has_role(auth.uid(), 'coo') OR
    public.has_role(auth.uid(), 'cfo')
  );

-- Index for fast lookups
CREATE INDEX idx_funder_visits_agent ON public.funder_visits(agent_id);
CREATE INDEX idx_funder_visits_funder ON public.funder_visits(funder_id);
CREATE INDEX idx_funder_visits_created ON public.funder_visits(created_at DESC);
