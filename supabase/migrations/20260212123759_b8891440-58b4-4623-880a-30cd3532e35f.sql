
-- Table to store OTP codes for phone verification
CREATE TABLE public.otp_verifications (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  otp_code TEXT NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  verified BOOLEAN NOT NULL DEFAULT false,
  verified_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.otp_verifications ENABLE ROW LEVEL SECURITY;

-- No public access - only edge functions with service role can access this table
-- No RLS policies needed since we use service role key in the edge function

-- Index for phone lookups
CREATE INDEX idx_otp_verifications_phone ON public.otp_verifications(phone);

-- Auto-cleanup: delete expired/verified OTPs older than 1 hour
CREATE OR REPLACE FUNCTION public.cleanup_old_otps()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM public.otp_verifications 
  WHERE (verified = true AND verified_at < now() - interval '1 hour')
     OR (expires_at < now() - interval '1 hour');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER trigger_cleanup_old_otps
AFTER INSERT ON public.otp_verifications
FOR EACH STATEMENT
EXECUTE FUNCTION public.cleanup_old_otps();
