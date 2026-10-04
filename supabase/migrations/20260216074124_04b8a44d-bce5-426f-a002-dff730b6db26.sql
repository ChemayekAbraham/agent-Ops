
-- Create the missing onboarding_targets table that a trigger references
CREATE TABLE IF NOT EXISTS public.onboarding_targets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL,
    target_month TEXT NOT NULL,
    target_count INTEGER NOT NULL DEFAULT 10,
    achieved_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.onboarding_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own targets" ON public.onboarding_targets
    FOR SELECT USING (auth.uid() = agent_id);

CREATE POLICY "System can manage targets" ON public.onboarding_targets
    FOR ALL USING (true) WITH CHECK (true);

-- Also create loan_applications if referenced
CREATE TABLE IF NOT EXISTS public.loan_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    amount NUMERIC NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.loan_applications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own applications" ON public.loan_applications
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create applications" ON public.loan_applications
    FOR INSERT WITH CHECK (auth.uid() = user_id);
