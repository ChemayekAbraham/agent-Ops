ALTER TABLE public.otp_verifications
  ADD COLUMN IF NOT EXISTS last_sent_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS send_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS send_window_start timestamp with time zone;