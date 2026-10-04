
-- Step 1: Add verification columns to agent_subagents
ALTER TABLE public.agent_subagents
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Step 2: Backfill all existing rows as 'verified' (they were already processed)
UPDATE public.agent_subagents SET status = 'verified' WHERE status = 'pending';

-- Step 3: Drop the old INSERT trigger
DROP TRIGGER IF EXISTS trg_award_subagent_commission ON public.agent_subagents;

-- Step 4: Replace the trigger function to work on UPDATE (status → verified)
CREATE OR REPLACE FUNCTION public.award_subagent_registration_bonus()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  -- Only fire when status transitions TO 'verified'
  IF NEW.status = 'verified' AND (OLD.status IS DISTINCT FROM 'verified') THEN
    SELECT public.credit_agent_event_bonus(
      NEW.parent_agent_id,
      NULL::UUID,
      'subagent_registration',
      NEW.sub_agent_id::TEXT
    ) INTO v_result;

    RAISE LOG '[award_subagent_registration_bonus] parent=% sub=% result=%',
      NEW.parent_agent_id, NEW.sub_agent_id, v_result;
  END IF;

  RETURN NEW;
END;
$$;

-- Step 5: Create new UPDATE trigger
CREATE TRIGGER trg_award_subagent_commission
AFTER UPDATE ON public.agent_subagents
FOR EACH ROW
EXECUTE FUNCTION public.award_subagent_registration_bonus();

-- Step 6: RLS policy for agent_ops to update status
CREATE POLICY "Staff can update agent_subagents status"
  ON public.agent_subagents
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);
