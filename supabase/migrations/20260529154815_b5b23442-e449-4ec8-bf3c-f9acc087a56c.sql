-- Credit Access Draws: add CFO manual-review/approval workflow columns.
-- Draws now submit themselves to the CFO (under Business Advance) as 'pending_cfo'
-- and are only disbursed to the wallet after the CFO edits + manually approves.
ALTER TABLE public.credit_access_draws
  ADD COLUMN IF NOT EXISTS requested_amount numeric,
  ADD COLUMN IF NOT EXISTS cfo_approved_by uuid,
  ADD COLUMN IF NOT EXISTS cfo_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS cfo_notes text,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz;

-- Helpful index for the CFO pending queue.
CREATE INDEX IF NOT EXISTS idx_credit_draws_status_submitted
  ON public.credit_access_draws (status, submitted_at);