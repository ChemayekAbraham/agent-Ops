-- Create tenant agreement acceptance table for compliance logging
CREATE TABLE public.tenant_agreement_acceptance (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  agreement_version TEXT NOT NULL DEFAULT 'v1.0',
  accepted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  ip_address TEXT,
  device_info TEXT,
  status TEXT NOT NULL DEFAULT 'accepted',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.tenant_agreement_acceptance ENABLE ROW LEVEL SECURITY;

-- Tenants can view their own acceptance records
CREATE POLICY "Tenants can view own acceptance"
ON public.tenant_agreement_acceptance
FOR SELECT
USING (auth.uid() = tenant_id);

-- Tenants can insert their own acceptance
CREATE POLICY "Tenants can insert own acceptance"
ON public.tenant_agreement_acceptance
FOR INSERT
WITH CHECK (auth.uid() = tenant_id);

-- Managers can view all acceptances for audit
CREATE POLICY "Managers can view all acceptances"
ON public.tenant_agreement_acceptance
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
    AND role = 'manager'
    AND enabled = true
  )
);

-- Create index for faster lookups
CREATE INDEX idx_tenant_agreement_tenant_id ON public.tenant_agreement_acceptance(tenant_id);
CREATE INDEX idx_tenant_agreement_version ON public.tenant_agreement_acceptance(agreement_version);