-- 1) Audit table
CREATE TABLE IF NOT EXISTS public.phone_collection_prompt_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('shown','snoozed','submitted','error')),
  phone_verified BOOLEAN,
  had_prior_phone BOOLEAN,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pcpe_user_time
  ON public.phone_collection_prompt_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pcpe_action_time
  ON public.phone_collection_prompt_events (action, created_at DESC);

-- 2) Grants (auth-only writes; ops read via RLS)
GRANT SELECT, INSERT ON public.phone_collection_prompt_events TO authenticated;
GRANT ALL ON public.phone_collection_prompt_events TO service_role;

-- 3) RLS
ALTER TABLE public.phone_collection_prompt_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users insert own phone-prompt events"
  ON public.phone_collection_prompt_events
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users read own phone-prompt events"
  ON public.phone_collection_prompt_events
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- Ops / leadership can read every row for support & analytics.
CREATE POLICY "ops read all phone-prompt events"
  ON public.phone_collection_prompt_events
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
  );