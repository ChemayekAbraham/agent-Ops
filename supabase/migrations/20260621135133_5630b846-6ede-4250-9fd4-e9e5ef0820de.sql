ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS verification_notify_email boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS verification_notify_sms boolean NOT NULL DEFAULT true;