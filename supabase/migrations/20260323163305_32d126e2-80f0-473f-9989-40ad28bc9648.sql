
-- Agent landlord payouts: tracks when an agent pays a landlord on behalf of the platform
CREATE TABLE public.agent_landlord_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.profiles(id),
  rent_request_id UUID NOT NULL,
  landlord_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  amount NUMERIC NOT NULL,
  
  -- MoMo payout details
  landlord_phone TEXT NOT NULL,
  landlord_name TEXT NOT NULL,
  mobile_money_provider TEXT NOT NULL,
  transaction_id TEXT,
  
  -- Receipt + GPS verification
  receipt_photo_urls TEXT[] DEFAULT '{}',
  latitude NUMERIC,
  longitude NUMERIC,
  location_accuracy NUMERIC,
  
  -- Property GPS for auto-match
  property_latitude NUMERIC,
  property_longitude NUMERIC,
  gps_match BOOLEAN DEFAULT false,
  gps_distance_meters NUMERIC,
  
  -- Approval chain
  status TEXT NOT NULL DEFAULT 'pending_receipt',
  -- statuses: pending_receipt, pending_landlord_ops, landlord_ops_approved, cfo_approved, completed, rejected
  
  landlord_ops_approved_by UUID,
  landlord_ops_approved_at TIMESTAMPTZ,
  landlord_ops_notes TEXT,
  
  cfo_approved_by UUID,
  cfo_approved_at TIMESTAMPTZ,
  cfo_notes TEXT,
  
  rejection_reason TEXT,
  
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.agent_landlord_payouts ENABLE ROW LEVEL SECURITY;

-- Agents can see their own payouts
CREATE POLICY "Agents can view own payouts" ON public.agent_landlord_payouts
  FOR SELECT TO authenticated
  USING (agent_id = auth.uid());

-- Agents can insert their own payouts
CREATE POLICY "Agents can insert own payouts" ON public.agent_landlord_payouts
  FOR INSERT TO authenticated
  WITH CHECK (agent_id = auth.uid());

-- Agents can update their own pending payouts (upload receipt/GPS)
CREATE POLICY "Agents can update own pending payouts" ON public.agent_landlord_payouts
  FOR UPDATE TO authenticated
  USING (agent_id = auth.uid() AND status IN ('pending_receipt', 'pending_landlord_ops'));

-- Staff can view all payouts
CREATE POLICY "Staff can view all payouts" ON public.agent_landlord_payouts
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles 
      WHERE user_id = auth.uid() 
      AND role IN ('manager', 'super_admin', 'coo', 'cfo', 'operations')
    )
  );

-- Staff can update payouts (approvals)
CREATE POLICY "Staff can update payouts" ON public.agent_landlord_payouts
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles 
      WHERE user_id = auth.uid() 
      AND role IN ('manager', 'super_admin', 'coo', 'cfo', 'operations')
    )
  );

-- Index for common queries
CREATE INDEX idx_agent_landlord_payouts_agent ON public.agent_landlord_payouts(agent_id);
CREATE INDEX idx_agent_landlord_payouts_status ON public.agent_landlord_payouts(status);
CREATE INDEX idx_agent_landlord_payouts_rent_request ON public.agent_landlord_payouts(rent_request_id);
