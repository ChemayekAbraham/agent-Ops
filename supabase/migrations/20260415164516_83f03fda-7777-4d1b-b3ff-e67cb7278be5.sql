
-- Agent Advance Requests table
CREATE TABLE public.agent_advance_requests (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  principal NUMERIC NOT NULL DEFAULT 0,
  cycle_days INTEGER NOT NULL DEFAULT 30,
  monthly_rate NUMERIC NOT NULL DEFAULT 0.33,
  access_fee NUMERIC NOT NULL DEFAULT 0,
  registration_fee NUMERIC NOT NULL DEFAULT 0,
  total_payable NUMERIC NOT NULL DEFAULT 0,
  daily_payment NUMERIC NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  
  -- Stage reviewers
  reviewed_by_agent_ops UUID REFERENCES public.profiles(id),
  agent_ops_reviewed_at TIMESTAMPTZ,
  agent_ops_notes TEXT,
  
  reviewed_by_tenant_ops UUID REFERENCES public.profiles(id),
  tenant_ops_reviewed_at TIMESTAMPTZ,
  tenant_ops_notes TEXT,
  
  reviewed_by_landlord_ops UUID REFERENCES public.profiles(id),
  landlord_ops_reviewed_at TIMESTAMPTZ,
  landlord_ops_notes TEXT,
  
  approved_by_coo UUID REFERENCES public.profiles(id),
  coo_approved_at TIMESTAMPTZ,
  coo_notes TEXT,
  
  paid_by_cfo UUID REFERENCES public.profiles(id),
  cfo_paid_at TIMESTAMPTZ,
  cfo_adjusted_rate NUMERIC,
  cfo_notes TEXT,
  
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_agent_advance_requests_agent_id ON public.agent_advance_requests(agent_id);
CREATE INDEX idx_agent_advance_requests_status ON public.agent_advance_requests(status);

-- Enable RLS
ALTER TABLE public.agent_advance_requests ENABLE ROW LEVEL SECURITY;

-- Agents can view their own requests
CREATE POLICY "Agents can view own advance requests"
ON public.agent_advance_requests
FOR SELECT
TO authenticated
USING (agent_id = auth.uid());

-- Agents can create requests for themselves
CREATE POLICY "Agents can create own advance requests"
ON public.agent_advance_requests
FOR INSERT
TO authenticated
WITH CHECK (agent_id = auth.uid());

-- Ops/COO/CFO can view all requests
CREATE POLICY "Ops and executives can view all advance requests"
ON public.agent_advance_requests
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin') OR
  public.has_role(auth.uid(), 'manager') OR
  public.has_role(auth.uid(), 'cfo') OR
  public.has_role(auth.uid(), 'coo')
);

-- Ops/COO/CFO can update requests
CREATE POLICY "Ops and executives can update advance requests"
ON public.agent_advance_requests
FOR UPDATE
TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin') OR
  public.has_role(auth.uid(), 'manager') OR
  public.has_role(auth.uid(), 'cfo') OR
  public.has_role(auth.uid(), 'coo')
);

-- Timestamp trigger
CREATE TRIGGER update_agent_advance_requests_updated_at
BEFORE UPDATE ON public.agent_advance_requests
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Advance Fee Config table (single-row)
CREATE TABLE public.advance_fee_config (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  default_monthly_rate NUMERIC NOT NULL DEFAULT 0.33,
  min_rate NUMERIC NOT NULL DEFAULT 0.28,
  max_rate NUMERIC NOT NULL DEFAULT 0.33,
  updated_by UUID REFERENCES public.profiles(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.advance_fee_config ENABLE ROW LEVEL SECURITY;

-- Everyone can read the config
CREATE POLICY "Authenticated users can view fee config"
ON public.advance_fee_config
FOR SELECT
TO authenticated
USING (true);

-- Only CFO/super_admin can update
CREATE POLICY "CFO can update fee config"
ON public.advance_fee_config
FOR UPDATE
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo') OR
  public.has_role(auth.uid(), 'super_admin')
);

-- Insert default row
INSERT INTO public.advance_fee_config (default_monthly_rate, min_rate, max_rate) VALUES (0.33, 0.28, 0.33);
