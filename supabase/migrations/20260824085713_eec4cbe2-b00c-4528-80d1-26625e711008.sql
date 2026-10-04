-- Stop the automatic verification bonus on rent request approval.
-- Drop the trigger first so it no longer fires on rent_requests updates.
DROP TRIGGER IF EXISTS trg_credit_verification_bonus ON public.rent_requests;

-- Drop the function that powered the trigger.
DROP FUNCTION IF EXISTS public.credit_agent_verification_bonus();