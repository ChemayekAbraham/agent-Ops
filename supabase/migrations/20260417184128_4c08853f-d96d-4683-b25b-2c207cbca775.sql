-- Auto-verify all new sub-agent registrations.
-- Removes the Agent Ops verification gate by defaulting status to 'verified'
-- on insert. We do NOT backfill existing rows here because the existing
-- AFTER UPDATE bonus trigger uses a non-allowlisted ledger category
-- (separate pre-existing issue).

ALTER TABLE public.agent_subagents
  ALTER COLUMN status SET DEFAULT 'verified';

CREATE OR REPLACE FUNCTION public.auto_verify_subagent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS NULL OR NEW.status = 'pending' THEN
    NEW.status := 'verified';
  END IF;
  IF NEW.status = 'verified' AND NEW.verified_at IS NULL THEN
    NEW.verified_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_verify_subagent ON public.agent_subagents;
CREATE TRIGGER trg_auto_verify_subagent
BEFORE INSERT ON public.agent_subagents
FOR EACH ROW
EXECUTE FUNCTION public.auto_verify_subagent();