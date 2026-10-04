-- Expand status check to include new manual-disbursement states
ALTER TABLE public.landlord_payouts
  DROP CONSTRAINT IF EXISTS landlord_payouts_status_check;

ALTER TABLE public.landlord_payouts
  ADD CONSTRAINT landlord_payouts_status_check
  CHECK (status = ANY (ARRAY[
    'otp_verified'::text,
    'pending_finops_disbursement'::text,
    'disbursing'::text,
    'awaiting_agent_receipt'::text,
    'completed'::text,
    'failed'::text,
    'escalated'::text
  ]));

-- Add Financial Ops disbursement tracking columns
ALTER TABLE public.landlord_payouts
  ADD COLUMN IF NOT EXISTS finops_disbursed_by uuid,
  ADD COLUMN IF NOT EXISTS finops_disbursed_at timestamptz,
  ADD COLUMN IF NOT EXISTS finops_momo_reference text,
  ADD COLUMN IF NOT EXISTS finops_notes text;

CREATE INDEX IF NOT EXISTS idx_landlord_payouts_pending_finops
  ON public.landlord_payouts (created_at)
  WHERE status = 'pending_finops_disbursement';

CREATE INDEX IF NOT EXISTS idx_landlord_payouts_awaiting_receipt
  ON public.landlord_payouts (agent_id, finops_disbursed_at)
  WHERE status = 'awaiting_agent_receipt';