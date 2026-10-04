ALTER TABLE public.agent_subagents
  ADD COLUMN IF NOT EXISTS acceptance_token uuid,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_agent_subagents_acceptance_token
  ON public.agent_subagents (acceptance_token);

-- Keep auto-verify behaviour for legacy 'pending' rows, but never auto-verify
-- rows that are explicitly waiting for the sub-agent to accept the invite.
CREATE OR REPLACE FUNCTION public.auto_verify_subagent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IS NULL OR NEW.status = 'pending' THEN
    NEW.status := 'verified';
  END IF;
  IF NEW.status = 'verified' AND NEW.verified_at IS NULL THEN
    NEW.verified_at := now();
  END IF;
  RETURN NEW;
END;
$function$;