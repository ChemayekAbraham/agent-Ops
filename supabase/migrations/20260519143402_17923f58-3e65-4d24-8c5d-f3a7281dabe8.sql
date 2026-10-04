CREATE TABLE public.rent_access_share_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  tenant_name TEXT,
  tenant_phone TEXT,
  channel TEXT NOT NULL CHECK (channel IN (
    'whatsapp','whatsapp_preview','sms','image_download','pdf_download','copy_link','native_share'
  )),
  image_version TEXT,
  limit_amount NUMERIC,
  share_url TEXT,
  message_snapshot TEXT,
  success BOOLEAN NOT NULL DEFAULT true,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rasa_agent ON public.rent_access_share_audit (agent_id, created_at DESC);
CREATE INDEX idx_rasa_tenant ON public.rent_access_share_audit (tenant_id, created_at DESC);
CREATE INDEX idx_rasa_channel ON public.rent_access_share_audit (channel, created_at DESC);

ALTER TABLE public.rent_access_share_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents insert their own share audit rows"
ON public.rent_access_share_audit
FOR INSERT
TO authenticated
WITH CHECK (agent_id = auth.uid());

CREATE POLICY "Agents view their own share audit rows"
ON public.rent_access_share_audit
FOR SELECT
TO authenticated
USING (agent_id = auth.uid());

CREATE POLICY "Privileged roles view all share audit rows"
ON public.rent_access_share_audit
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'operations'::app_role)
);