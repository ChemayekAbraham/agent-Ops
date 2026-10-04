-- Field collections: offline-first cash captures by agents, pending review before posting to tenant accounts
CREATE TABLE IF NOT EXISTS public.field_collections (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_uuid TEXT NOT NULL,
  agent_id UUID NOT NULL,
  tenant_id UUID,
  tenant_name TEXT NOT NULL,
  tenant_phone TEXT,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  notes TEXT,
  location_name TEXT,
  latitude NUMERIC,
  longitude NUMERIC,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending',
  confirmed_at TIMESTAMPTZ,
  confirmed_collection_id UUID,
  rejected_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT field_collections_status_check CHECK (status IN ('pending','confirmed','rejected','cancelled')),
  CONSTRAINT field_collections_agent_client_uuid_unique UNIQUE (agent_id, client_uuid)
);

CREATE INDEX IF NOT EXISTS idx_field_collections_agent_status ON public.field_collections(agent_id, status, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_field_collections_tenant ON public.field_collections(tenant_id);

ALTER TABLE public.field_collections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents can view their own field collections"
ON public.field_collections FOR SELECT
USING (auth.uid() = agent_id);

CREATE POLICY "Agents can insert their own field collections"
ON public.field_collections FOR INSERT
WITH CHECK (auth.uid() = agent_id);

CREATE POLICY "Agents can update their own pending field collections"
ON public.field_collections FOR UPDATE
USING (auth.uid() = agent_id AND status = 'pending')
WITH CHECK (auth.uid() = agent_id);

CREATE POLICY "Agents can delete their own pending field collections"
ON public.field_collections FOR DELETE
USING (auth.uid() = agent_id AND status = 'pending');

-- Updated_at trigger
CREATE TRIGGER trg_field_collections_updated_at
BEFORE UPDATE ON public.field_collections
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();