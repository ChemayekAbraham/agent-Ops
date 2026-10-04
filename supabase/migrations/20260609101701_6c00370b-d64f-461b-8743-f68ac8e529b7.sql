ALTER TABLE public.landlord_payout_otp_events
  ADD COLUMN IF NOT EXISTS failure_reason text;