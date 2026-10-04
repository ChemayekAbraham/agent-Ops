
-- Add multi-stage approval columns to withdrawal_requests
ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS manager_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS manager_approved_by uuid,
  ADD COLUMN IF NOT EXISTS cfo_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS cfo_approved_by uuid,
  ADD COLUMN IF NOT EXISTS coo_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS coo_approved_by uuid;
