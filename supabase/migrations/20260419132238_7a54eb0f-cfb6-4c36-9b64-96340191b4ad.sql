-- Add structured residence address + agent management fields to profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS region text,
  ADD COLUMN IF NOT EXISTS district text,
  ADD COLUMN IF NOT EXISTS sub_county text,
  ADD COLUMN IF NOT EXISTS parish text,
  ADD COLUMN IF NOT EXISTS village text,
  ADD COLUMN IF NOT EXISTS landmark text,
  ADD COLUMN IF NOT EXISTS residence_lat numeric,
  ADD COLUMN IF NOT EXISTS residence_lng numeric,
  ADD COLUMN IF NOT EXISTS residence_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS managed_by_agent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS managing_agent_id uuid;

CREATE INDEX IF NOT EXISTS idx_profiles_managing_agent
  ON public.profiles (managing_agent_id) WHERE managing_agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_managed_by_agent
  ON public.profiles (managed_by_agent) WHERE managed_by_agent = true;

-- Audit log table for agent-on-behalf actions
CREATE TABLE IF NOT EXISTS public.agent_managed_user_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  user_id uuid NOT NULL,
  action_type text NOT NULL,
  details jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.agent_managed_user_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents can insert their own managed actions"
  ON public.agent_managed_user_actions FOR INSERT
  WITH CHECK (auth.uid() = agent_id AND has_role(auth.uid(), 'agent'::app_role));

CREATE POLICY "Agents can view their own managed actions"
  ON public.agent_managed_user_actions FOR SELECT
  USING (auth.uid() = agent_id);

CREATE POLICY "Managers can view all managed actions"
  ON public.agent_managed_user_actions FOR SELECT
  USING (has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

CREATE INDEX IF NOT EXISTS idx_agent_managed_actions_agent ON public.agent_managed_user_actions (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_managed_actions_user ON public.agent_managed_user_actions (user_id, created_at DESC);

-- Auto-revoke management when the user signs in themselves
CREATE OR REPLACE FUNCTION public.revoke_agent_management_on_user_login()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.last_sign_in_at IS DISTINCT FROM OLD.last_sign_in_at AND NEW.last_sign_in_at IS NOT NULL THEN
    UPDATE public.profiles
    SET managed_by_agent = false,
        managing_agent_id = NULL,
        updated_at = now()
    WHERE id = NEW.id AND managed_by_agent = true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_revoke_agent_mgmt_on_login ON auth.users;
CREATE TRIGGER trg_revoke_agent_mgmt_on_login
  AFTER UPDATE OF last_sign_in_at ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.revoke_agent_management_on_user_login();

-- RLS: managing agent can view managed user's profile
CREATE POLICY "Managing agent can view managed user profile"
  ON public.profiles FOR SELECT
  USING (
    managed_by_agent = true
    AND managing_agent_id = auth.uid()
    AND has_role(auth.uid(), 'agent'::app_role)
  );

-- RLS: managing agent can update profile fields of managed user
CREATE POLICY "Managing agent can update managed user profile"
  ON public.profiles FOR UPDATE
  USING (
    managed_by_agent = true
    AND managing_agent_id = auth.uid()
    AND has_role(auth.uid(), 'agent'::app_role)
  )
  WITH CHECK (
    managed_by_agent = true
    AND managing_agent_id = auth.uid()
    AND has_role(auth.uid(), 'agent'::app_role)
  );

-- RLS: managing agent can view managed user's wallet
CREATE POLICY "Managing agent can view managed user wallet"
  ON public.wallets FOR SELECT
  USING (
    has_role(auth.uid(), 'agent'::app_role)
    AND user_id IN (
      SELECT id FROM public.profiles
      WHERE managed_by_agent = true AND managing_agent_id = auth.uid()
    )
  );