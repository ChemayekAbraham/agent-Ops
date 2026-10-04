ALTER TABLE public.landlords
  ADD COLUMN IF NOT EXISTS receipt_verification_status text
    CHECK (receipt_verification_status IN ('true_landlord', 'false_landlord')),
  ADD COLUMN IF NOT EXISTS receipt_verification_at timestamptz,
  ADD COLUMN IF NOT EXISTS receipt_verification_by uuid,
  ADD COLUMN IF NOT EXISTS receipt_verification_note text,
  ADD COLUMN IF NOT EXISTS receipt_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS receipt_requested_by uuid,
  ADD COLUMN IF NOT EXISTS receipt_request_channel text
    CHECK (receipt_request_channel IN ('whatsapp', 'call'));

CREATE INDEX IF NOT EXISTS landlords_receipt_verification_status_idx
  ON public.landlords (receipt_verification_status);