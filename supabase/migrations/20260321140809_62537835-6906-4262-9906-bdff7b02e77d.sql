-- Auto-verify agents when they post their first rent request
CREATE OR REPLACE FUNCTION public.auto_verify_agent_on_rent_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only act if agent_id is set
  IF NEW.agent_id IS NOT NULL THEN
    -- Set verified = true on the agent's profile if not already verified
    UPDATE public.profiles
    SET verified = true
    WHERE id = NEW.agent_id
      AND (verified IS NULL OR verified = false);
  END IF;
  RETURN NEW;
END;
$$;

-- Attach trigger to rent_requests table
DROP TRIGGER IF EXISTS trg_auto_verify_agent ON public.rent_requests;
CREATE TRIGGER trg_auto_verify_agent
  AFTER INSERT ON public.rent_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_verify_agent_on_rent_request();

-- Backfill: verify all agents who already have at least 1 rent request
UPDATE public.profiles
SET verified = true
WHERE id IN (
  SELECT DISTINCT agent_id FROM public.rent_requests WHERE agent_id IS NOT NULL
)
AND (verified IS NULL OR verified = false);