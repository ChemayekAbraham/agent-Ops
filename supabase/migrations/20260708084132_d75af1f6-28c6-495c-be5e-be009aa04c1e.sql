
-- Count of a sub-agent's valid (non-rejected) house listings
CREATE OR REPLACE FUNCTION public.subagent_listing_count(p_sub_agent_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(count(*), 0)::int
  FROM public.house_listings
  WHERE agent_id = p_sub_agent_id
    AND COALESCE(status, '') <> 'rejected';
$$;

-- Gated award: only pays the parent agent(s) once the verified sub-agent
-- has listed >= 3 valid houses. Idempotent via credit_agent_event_bonus
-- (source_id = sub_agent_id).
CREATE OR REPLACE FUNCTION public.try_award_subagent_registration_bonus(p_sub_agent_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r RECORD;
BEGIN
  IF p_sub_agent_id IS NULL THEN
    RETURN;
  END IF;

  -- Rule: sub-agent must have listed at least 3 valid houses
  IF public.subagent_listing_count(p_sub_agent_id) < 3 THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT DISTINCT parent_agent_id
    FROM public.agent_subagents
    WHERE sub_agent_id = p_sub_agent_id
      AND status = 'verified'
      AND parent_agent_id IS NOT NULL
  LOOP
    PERFORM public.credit_agent_event_bonus(
      r.parent_agent_id,
      'subagent_registration',
      NULL::uuid,
      p_sub_agent_id::text
    );
  END LOOP;
END;
$$;

-- Replace the verification trigger to enforce the >= 3 listings rule
CREATE OR REPLACE FUNCTION public.award_subagent_registration_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_should_attempt BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'verified' THEN
    v_should_attempt := TRUE;
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'verified'
        AND (OLD.status IS DISTINCT FROM 'verified') THEN
    v_should_attempt := TRUE;
  END IF;

  IF v_should_attempt THEN
    PERFORM public.try_award_subagent_registration_bonus(NEW.sub_agent_id);
  END IF;

  RETURN NEW;
END;
$$;

-- Retroactive award: when a sub-agent adds/updates listings and crosses the
-- 3-listing threshold, pay the parent agent (only if verified + not already paid).
CREATE OR REPLACE FUNCTION public.award_subagent_bonus_on_listing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.agent_id IS NOT NULL AND COALESCE(NEW.status, '') <> 'rejected' THEN
    PERFORM public.try_award_subagent_registration_bonus(NEW.agent_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_award_subagent_bonus_on_listing ON public.house_listings;
CREATE TRIGGER trg_award_subagent_bonus_on_listing
AFTER INSERT OR UPDATE OF status ON public.house_listings
FOR EACH ROW
EXECUTE FUNCTION public.award_subagent_bonus_on_listing();
