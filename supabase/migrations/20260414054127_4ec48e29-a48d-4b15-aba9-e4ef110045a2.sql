
-- Employee agreement acceptance table
CREATE TABLE public.employee_agreement_acceptance (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  agreement_version TEXT NOT NULL DEFAULT 'v1.0',
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address TEXT,
  device_info TEXT,
  status TEXT NOT NULL DEFAULT 'accepted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.employee_agreement_acceptance ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own employee agreement"
  ON public.employee_agreement_acceptance FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can accept employee agreement"
  ON public.employee_agreement_acceptance FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Add job_title and agreement_accepted to staff_profiles
ALTER TABLE public.staff_profiles
  ADD COLUMN IF NOT EXISTS job_title TEXT,
  ADD COLUMN IF NOT EXISTS agreement_accepted BOOLEAN NOT NULL DEFAULT false;
