ALTER TABLE public.deposit_requests
  ADD COLUMN IF NOT EXISTS auto_credit_review_status text,
  ADD COLUMN IF NOT EXISTS auto_credit_reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS auto_credit_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_credit_review_notes text;

ALTER TABLE public.deposit_requests
  DROP CONSTRAINT IF EXISTS deposit_requests_auto_credit_review_status_chk;
ALTER TABLE public.deposit_requests
  ADD CONSTRAINT deposit_requests_auto_credit_review_status_chk
  CHECK (auto_credit_review_status IS NULL OR auto_credit_review_status IN ('confirmed','reversed'));

CREATE INDEX IF NOT EXISTS idx_deposit_requests_auto_credit_review
  ON public.deposit_requests (auto_credit_reviewed_at DESC)
  WHERE auto_approved = true;