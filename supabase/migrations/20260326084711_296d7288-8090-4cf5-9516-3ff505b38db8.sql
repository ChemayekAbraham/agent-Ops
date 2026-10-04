
-- Table to store tenant rent request deletion history with financial snapshots
CREATE TABLE public.rent_request_deletions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  tenant_name TEXT NOT NULL,
  tenant_phone TEXT,
  agent_id UUID,
  agent_name TEXT,
  agent_phone TEXT,
  rent_amount NUMERIC NOT NULL DEFAULT 0,
  amount_repaid NUMERIC NOT NULL DEFAULT 0,
  outstanding NUMERIC NOT NULL DEFAULT 0,
  total_repayment NUMERIC NOT NULL DEFAULT 0,
  daily_repayment NUMERIC NOT NULL DEFAULT 0,
  tenant_wallet NUMERIC NOT NULL DEFAULT 0,
  disbursed_at TIMESTAMPTZ,
  request_status TEXT,
  deleted_by UUID NOT NULL,
  deleted_by_name TEXT,
  deletion_reason TEXT,
  snapshot_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days')
);

-- RLS
ALTER TABLE public.rent_request_deletions ENABLE ROW LEVEL SECURITY;

-- Only staff can view deletion history
CREATE POLICY "Staff can view deletion history"
ON public.rent_request_deletions FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
    AND ur.role IN ('manager', 'super_admin', 'operations', 'coo', 'cfo')
  )
);

-- Only the edge function (service role) inserts
CREATE POLICY "Service role inserts deletion history"
ON public.rent_request_deletions FOR INSERT
TO authenticated
WITH CHECK (false);
