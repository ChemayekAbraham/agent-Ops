
ALTER TABLE public.investment_withdrawal_requests
  ADD COLUMN IF NOT EXISTS partner_ops_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS partner_ops_approved_by uuid,
  ADD COLUMN IF NOT EXISTS coo_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS coo_approved_by uuid,
  ADD COLUMN IF NOT EXISTS cfo_processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS cfo_processed_by uuid,
  ADD COLUMN IF NOT EXISTS rejection_reason text;
