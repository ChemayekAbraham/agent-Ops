
CREATE OR REPLACE FUNCTION public.enforce_no_double_agent_advance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only guard fresh requests entering the review pipeline
  IF NEW.status NOT IN ('pending','agent_ops_approved','tenant_ops_approved','landlord_ops_approved','coo_approved') THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.agent_advances
    WHERE agent_id = NEW.agent_id
      AND status IN ('active','overdue')
      AND outstanding_balance > 0
  ) THEN
    RAISE EXCEPTION 'Agent already has an ongoing advance with an outstanding balance. Repay it in full before requesting a new one.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Also block if another request is already mid-pipeline
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM public.agent_advance_requests
    WHERE agent_id = NEW.agent_id
      AND id <> NEW.id
      AND status IN ('pending','agent_ops_approved','tenant_ops_approved','landlord_ops_approved','coo_approved')
  ) THEN
    RAISE EXCEPTION 'Agent already has a pending advance request in the approval pipeline.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_no_double_agent_advance ON public.agent_advance_requests;
CREATE TRIGGER trg_enforce_no_double_agent_advance
  BEFORE INSERT ON public.agent_advance_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_no_double_agent_advance();
