-- Create landlord agreement acceptance table
CREATE TABLE public.landlord_agreement_acceptance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id UUID NOT NULL,
  agreement_version TEXT NOT NULL DEFAULT 'v1.0',
  status TEXT NOT NULL DEFAULT 'accepted',
  accepted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  device_info TEXT,
  ip_address TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.landlord_agreement_acceptance ENABLE ROW LEVEL SECURITY;

-- Users can view their own acceptance
CREATE POLICY "Users can view own landlord agreement" 
ON public.landlord_agreement_acceptance 
FOR SELECT 
USING (auth.uid() = landlord_id);

-- Users can insert their own acceptance
CREATE POLICY "Users can accept landlord agreement" 
ON public.landlord_agreement_acceptance 
FOR INSERT 
WITH CHECK (auth.uid() = landlord_id);

-- Create index for faster lookups
CREATE INDEX idx_landlord_agreement_landlord_id ON public.landlord_agreement_acceptance(landlord_id);
CREATE INDEX idx_landlord_agreement_accepted_at ON public.landlord_agreement_acceptance(accepted_at DESC);