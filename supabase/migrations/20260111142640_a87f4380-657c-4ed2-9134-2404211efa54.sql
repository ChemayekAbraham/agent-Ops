-- Create table for supporter agreement acceptance tracking
CREATE TABLE public.supporter_agreement_acceptance (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  supporter_id UUID NOT NULL,
  agreement_version TEXT NOT NULL DEFAULT 'v1.0',
  accepted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  ip_address TEXT,
  device_info TEXT,
  status TEXT NOT NULL DEFAULT 'accepted',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.supporter_agreement_acceptance ENABLE ROW LEVEL SECURITY;

-- Create policy for supporters to view their own acceptances
CREATE POLICY "Supporters can view their own acceptances"
ON public.supporter_agreement_acceptance
FOR SELECT
USING (auth.uid() = supporter_id);

-- Create policy for supporters to insert their own acceptances
CREATE POLICY "Supporters can insert their own acceptances"
ON public.supporter_agreement_acceptance
FOR INSERT
WITH CHECK (auth.uid() = supporter_id);

-- Create index for faster lookups
CREATE INDEX idx_supporter_agreement_supporter_version ON public.supporter_agreement_acceptance(supporter_id, agreement_version);

-- Create index for audit queries
CREATE INDEX idx_supporter_agreement_accepted_at ON public.supporter_agreement_acceptance(accepted_at DESC);