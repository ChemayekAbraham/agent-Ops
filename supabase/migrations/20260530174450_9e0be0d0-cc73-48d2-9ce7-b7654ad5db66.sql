ALTER TABLE public.otp_verifications
  ADD COLUMN IF NOT EXISTS send_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS send_status_reason text,
  ADD COLUMN IF NOT EXISTS send_status_at timestamp with time zone;