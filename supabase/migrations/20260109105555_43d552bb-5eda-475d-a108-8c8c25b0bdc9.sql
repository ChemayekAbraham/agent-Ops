-- Create onboarding_targets table for manager goal setting
CREATE TABLE public.onboarding_targets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  target_month DATE NOT NULL,
  target_count INTEGER NOT NULL,
  set_by UUID NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(target_month)
);

-- Enable RLS
ALTER TABLE public.onboarding_targets ENABLE ROW LEVEL SECURITY;

-- Managers can view all targets
CREATE POLICY "Managers can view onboarding targets"
ON public.onboarding_targets
FOR SELECT
USING (
  EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'manager')
);

-- Managers can create targets
CREATE POLICY "Managers can create onboarding targets"
ON public.onboarding_targets
FOR INSERT
WITH CHECK (
  EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'manager')
);

-- Managers can update targets
CREATE POLICY "Managers can update onboarding targets"
ON public.onboarding_targets
FOR UPDATE
USING (
  EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'manager')
);

-- Add updated_at trigger
CREATE TRIGGER update_onboarding_targets_updated_at
BEFORE UPDATE ON public.onboarding_targets
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();