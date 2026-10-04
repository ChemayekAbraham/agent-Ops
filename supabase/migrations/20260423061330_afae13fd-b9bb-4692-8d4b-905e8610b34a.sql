-- Make link signups create the sub-agent relationship automatically.
-- When a new user signs up via /auth?ref=<agentId>&become=agent, the recruiter
-- (referrer) must be linked as parent_agent_id in agent_subagents so that:
--   1. award_subagent_registration_bonus fires (UGX 10,000 to recruiter)
--   2. credit_agent_rent_commission routes a 2% override on every future
--      rent collection by the new sub-agent to the recruiter.
--
-- We extend handle_new_user (the trigger that already runs on auth.users insert
-- with SECURITY DEFINER) to insert the agent_subagents row when:
--   - intended_role from signup metadata is 'agent', AND
--   - referrer_id is present and not the new user themselves, AND
--   - the referrer is an existing agent (has the 'agent' role).
--
-- The existing BEFORE INSERT trigger auto_verify_subagent flips status to
-- 'verified' immediately, which then fires award_subagent_registration_bonus
-- via the AFTER UPDATE trigger. To make sure the registration bonus also
-- fires when the row is inserted directly as 'verified' (no UPDATE happens),
-- we tweak the bonus trigger to fire on INSERT too.

-- 1. Allow the registration bonus to fire on INSERT (in addition to status transitions on UPDATE).
CREATE OR REPLACE FUNCTION public.award_subagent_registration_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_result JSONB;
  v_should_award BOOLEAN := FALSE;
BEGIN
  -- Fire on INSERT when the new row is already verified, OR
  -- on UPDATE when status transitions to 'verified'.
  IF TG_OP = 'INSERT' AND NEW.status = 'verified' THEN
    v_should_award := TRUE;
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'verified'
        AND (OLD.status IS DISTINCT FROM 'verified') THEN
    v_should_award := TRUE;
  END IF;

  IF v_should_award THEN
    SELECT public.credit_agent_event_bonus(
      NEW.parent_agent_id,
      'subagent_registration',
      NULL::UUID,
      NEW.sub_agent_id::TEXT
    ) INTO v_result;

    RAISE LOG '[award_subagent_registration_bonus] op=% parent=% sub=% result=%',
      TG_OP, NEW.parent_agent_id, NEW.sub_agent_id, v_result;
  END IF;

  RETURN NEW;
END;
$function$;

-- Re-create the trigger to also fire on INSERT.
DROP TRIGGER IF EXISTS trg_award_subagent_commission ON public.agent_subagents;
CREATE TRIGGER trg_award_subagent_commission
AFTER INSERT OR UPDATE ON public.agent_subagents
FOR EACH ROW EXECUTE FUNCTION public.award_subagent_registration_bonus();

-- 2. Extend handle_new_user to write the agent_subagents row.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_referrer_id  uuid;
  v_intended_role text;
  v_referrer_is_agent boolean := FALSE;
BEGIN
  v_referrer_id := NULLIF(NEW.raw_user_meta_data->>'referrer_id', '')::uuid;
  v_intended_role := NULLIF(NEW.raw_user_meta_data->>'intended_role', '');

  -- 1) Profile (existing behavior).
  INSERT INTO public.profiles (id, email, full_name, phone, referrer_id)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'phone', ''),
    v_referrer_id
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), profiles.full_name),
    phone = COALESCE(NULLIF(EXCLUDED.phone, ''), profiles.phone),
    referrer_id = COALESCE(EXCLUDED.referrer_id, profiles.referrer_id),
    updated_at = now();

  -- 2) If they signed up via a sub-agent recruit link, create the link row.
  --    Conditions: intended_role = 'agent', referrer present, referrer is
  --    an existing agent, and not self-referral.
  IF v_intended_role = 'agent' AND v_referrer_id IS NOT NULL AND v_referrer_id <> NEW.id THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = v_referrer_id AND role = 'agent'
    ) INTO v_referrer_is_agent;

    IF v_referrer_is_agent THEN
      INSERT INTO public.agent_subagents (parent_agent_id, sub_agent_id, source, status)
      VALUES (v_referrer_id, NEW.id, 'link_signup', 'verified')
      ON CONFLICT (sub_agent_id) DO NOTHING;
    END IF;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Log but never block account creation.
  RAISE WARNING 'handle_new_user failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;