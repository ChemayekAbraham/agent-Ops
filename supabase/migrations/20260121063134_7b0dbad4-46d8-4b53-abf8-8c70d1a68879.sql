-- Create agent agreement acceptance table
CREATE TABLE public.agent_agreement_acceptance (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID NOT NULL,
  agreement_version TEXT NOT NULL DEFAULT 'v1.0',
  accepted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  ip_address TEXT,
  device_info TEXT,
  status TEXT NOT NULL DEFAULT 'accepted',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.agent_agreement_acceptance ENABLE ROW LEVEL SECURITY;

-- Agents can view their own acceptance
CREATE POLICY "Agents can view own acceptance"
ON public.agent_agreement_acceptance
FOR SELECT
USING (auth.uid() = agent_id);

-- Agents can insert their own acceptance
CREATE POLICY "Agents can insert own acceptance"
ON public.agent_agreement_acceptance
FOR INSERT
WITH CHECK (auth.uid() = agent_id);

-- Managers can view all acceptances
CREATE POLICY "Managers can view all agent acceptances"
ON public.agent_agreement_acceptance
FOR SELECT
USING (EXISTS (
  SELECT 1 FROM user_roles
  WHERE user_roles.user_id = auth.uid()
  AND user_roles.role = 'manager'
  AND user_roles.enabled = true
));

-- Create index for faster lookups
CREATE INDEX idx_agent_agreement_agent_id ON public.agent_agreement_acceptance(agent_id);
CREATE INDEX idx_agent_agreement_version ON public.agent_agreement_acceptance(agreement_version);