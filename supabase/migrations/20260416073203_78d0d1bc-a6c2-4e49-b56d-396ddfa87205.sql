
-- Add landlord verification checklist to rent_requests
ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS landlord_called boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS landlord_acknowledged boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS landlord_verification_method text,
  ADD COLUMN IF NOT EXISTS landlord_call_notes text;

-- Add OTP verification tracking to agent_float_withdrawals
ALTER TABLE public.agent_float_withdrawals
  ADD COLUMN IF NOT EXISTS landlord_otp_verified boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS landlord_otp_verified_at timestamptz;
