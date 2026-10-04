
-- Add fin_ops_verified columns to withdrawal_requests
ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS fin_ops_reference text,
  ADD COLUMN IF NOT EXISTS fin_ops_verified_by uuid,
  ADD COLUMN IF NOT EXISTS fin_ops_verified_at timestamptz;
