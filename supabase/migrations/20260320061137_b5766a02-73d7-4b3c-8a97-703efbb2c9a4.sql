
-- Add pipeline tracking columns to rent_requests
ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS tenant_ops_reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS tenant_ops_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS assigned_agent_id uuid,
  ADD COLUMN IF NOT EXISTS landlord_ops_reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS landlord_ops_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS coo_reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS coo_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS cfo_reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS cfo_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS payout_transaction_reference text,
  ADD COLUMN IF NOT EXISTS payout_method text DEFAULT 'wallet';

-- Add comment for documentation
COMMENT ON COLUMN public.rent_requests.payout_method IS 'wallet or cash - how landlord receives funds';
COMMENT ON COLUMN public.rent_requests.payout_transaction_reference IS 'External transaction ID confirming landlord payout';
COMMENT ON COLUMN public.rent_requests.assigned_agent_id IS 'Agent assigned by Tenant Ops (may differ from original agent_id)';

-- Index for pipeline stage queries
CREATE INDEX IF NOT EXISTS idx_rent_requests_status_pipeline ON public.rent_requests (status) WHERE status IN ('pending', 'tenant_ops_approved', 'agent_verified', 'landlord_ops_approved', 'coo_approved', 'funded', 'disbursed');
