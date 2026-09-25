ALTER TABLE public.share_onboarding_requests
  ADD COLUMN IF NOT EXISTS funding_source text NOT NULL DEFAULT 'shareholder',
  ADD COLUMN IF NOT EXISTS funder_user_id uuid;
ALTER TABLE public.share_onboarding_requests
  ADD CONSTRAINT share_onboarding_funding_source_ck CHECK (funding_source IN ('shareholder','creator'));
COMMENT ON COLUMN public.share_onboarding_requests.funder_user_id IS 'User whose operational float pays for the shares; NULL = shareholder pays.';