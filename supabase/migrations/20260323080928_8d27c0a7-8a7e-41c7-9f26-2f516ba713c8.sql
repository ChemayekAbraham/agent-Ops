
-- Table to track 2-stage approval for house listing commissions
-- Flow: Agent lists empty house → Landlord Ops approves → CFO approves → Paid to agent wallet
CREATE TABLE public.listing_bonus_approvals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  listing_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 5000,
  status TEXT NOT NULL DEFAULT 'pending_landlord_ops',
  -- Stage 1: Landlord Ops
  landlord_ops_approved_by UUID,
  landlord_ops_approved_at TIMESTAMPTZ,
  landlord_ops_notes TEXT,
  -- Stage 2: CFO
  cfo_approved_by UUID,
  cfo_approved_at TIMESTAMPTZ,
  cfo_notes TEXT,
  -- Rejection
  rejected_by UUID,
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  -- Payment
  paid_at TIMESTAMPTZ,
  ledger_entry_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT listing_bonus_status_check CHECK (status IN ('pending_landlord_ops', 'pending_cfo', 'approved', 'paid', 'rejected'))
);

-- Indexes
CREATE INDEX idx_listing_bonus_approvals_status ON public.listing_bonus_approvals(status);
CREATE INDEX idx_listing_bonus_approvals_agent ON public.listing_bonus_approvals(agent_id);
CREATE UNIQUE INDEX idx_listing_bonus_approvals_listing ON public.listing_bonus_approvals(listing_id);

-- Enable RLS
ALTER TABLE public.listing_bonus_approvals ENABLE ROW LEVEL SECURITY;

-- Agents can see their own approvals
CREATE POLICY "Agents can view own bonus approvals"
  ON public.listing_bonus_approvals FOR SELECT
  USING (auth.uid() = agent_id);

-- Managers/ops/cfo can view all
CREATE POLICY "Staff can view all bonus approvals"
  ON public.listing_bonus_approvals FOR SELECT
  USING (
    public.has_role(auth.uid(), 'manager') OR
    public.has_role(auth.uid(), 'super_admin') OR
    public.has_role(auth.uid(), 'cfo') OR
    public.has_role(auth.uid(), 'operations') OR
    public.has_role(auth.uid(), 'coo')
  );

-- Only service role inserts/updates (via edge functions)
CREATE POLICY "Service role manages bonus approvals"
  ON public.listing_bonus_approvals FOR ALL
  USING (auth.role() = 'service_role');

-- Timestamp trigger
CREATE TRIGGER update_listing_bonus_approvals_updated_at
  BEFORE UPDATE ON public.listing_bonus_approvals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
