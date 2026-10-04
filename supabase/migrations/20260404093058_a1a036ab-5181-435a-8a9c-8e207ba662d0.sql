
-- Step 1: Create trigger function that awards UGX 10,000 sub-agent bonus on agent_subagents insert
CREATE OR REPLACE FUNCTION public.award_subagent_registration_bonus()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  -- Call the existing idempotent RPC to award the bonus
  -- Uses sub_agent_id as source_id for idempotency (one bonus per sub-agent relationship)
  SELECT public.credit_agent_event_bonus(
    NEW.parent_agent_id,
    NULL::UUID,
    'subagent_registration',
    NEW.sub_agent_id::TEXT
  ) INTO v_result;

  RAISE LOG '[award_subagent_registration_bonus] parent=% sub=% result=%',
    NEW.parent_agent_id, NEW.sub_agent_id, v_result;

  RETURN NEW;
END;
$$;

-- Step 2: Create trigger on agent_subagents (drop first if exists)
DROP TRIGGER IF EXISTS trg_award_subagent_commission ON public.agent_subagents;

CREATE TRIGGER trg_award_subagent_commission
AFTER INSERT ON public.agent_subagents
FOR EACH ROW
EXECUTE FUNCTION public.award_subagent_registration_bonus();
