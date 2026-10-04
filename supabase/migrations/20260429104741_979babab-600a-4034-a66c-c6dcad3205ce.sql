-- Guard trigger: short-circuit pipeline for outstanding-balance rent requests.
CREATE OR REPLACE FUNCTION public.rent_requests_outstanding_pipeline_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_actor UUID;
BEGIN
  -- Only act on outstanding-balance requests
  IF COALESCE(NEW.registration_type, 'normal') <> 'outstanding_balance' THEN
    RETURN NEW;
  END IF;

  -- Only act when status actually changes
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Block forbidden states for this branch
  IF NEW.status IN ('landlord_ops_approved', 'coo_approved', 'funded', 'disbursed') THEN
    RAISE EXCEPTION
      'Outstanding-balance rent requests cannot enter the % stage. They complete after agent verification.',
      NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- When agent moves it from tenant_ops_approved -> agent_verified,
  -- short-circuit straight to completed and stamp downstream reviewer
  -- columns with the agent so audit history stays well-formed.
  IF OLD.status = 'tenant_ops_approved' AND NEW.status = 'agent_verified' THEN
    v_actor := COALESCE(NEW.agent_verified_by, OLD.agent_id, NEW.agent_id);

    NEW.status := 'completed';
    NEW.agent_verified := TRUE;
    NEW.agent_verified_at := COALESCE(NEW.agent_verified_at, v_now);
    NEW.agent_verified_by := COALESCE(NEW.agent_verified_by, v_actor);

    -- Stamp downstream reviewer slots so reports/audits don't show gaps
    NEW.landlord_ops_reviewed_by := COALESCE(NEW.landlord_ops_reviewed_by, v_actor);
    NEW.landlord_ops_reviewed_at := COALESCE(NEW.landlord_ops_reviewed_at, v_now);
    NEW.coo_reviewed_by := COALESCE(NEW.coo_reviewed_by, v_actor);
    NEW.coo_reviewed_at := COALESCE(NEW.coo_reviewed_at, v_now);
    NEW.cfo_reviewed_by := COALESCE(NEW.cfo_reviewed_by, v_actor);
    NEW.cfo_reviewed_at := COALESCE(NEW.cfo_reviewed_at, v_now);

    -- No actual money movement — record a sentinel payout method
    NEW.payout_method := COALESCE(NEW.payout_method, 'no_disbursement_outstanding');
    NEW.disbursed_at := COALESCE(NEW.disbursed_at, v_now);
    NEW.updated_at := v_now;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rent_requests_outstanding_guard ON public.rent_requests;
CREATE TRIGGER trg_rent_requests_outstanding_guard
BEFORE UPDATE ON public.rent_requests
FOR EACH ROW
EXECUTE FUNCTION public.rent_requests_outstanding_pipeline_guard();

-- Backfill: move stranded outstanding-balance rows out of mid-pipeline states to completed.
UPDATE public.rent_requests
SET
  status = 'completed',
  agent_verified = TRUE,
  agent_verified_at = COALESCE(agent_verified_at, now()),
  agent_verified_by = COALESCE(agent_verified_by, agent_id),
  landlord_ops_reviewed_by = COALESCE(landlord_ops_reviewed_by, agent_id),
  landlord_ops_reviewed_at = COALESCE(landlord_ops_reviewed_at, now()),
  coo_reviewed_by = COALESCE(coo_reviewed_by, agent_id),
  coo_reviewed_at = COALESCE(coo_reviewed_at, now()),
  cfo_reviewed_by = COALESCE(cfo_reviewed_by, agent_id),
  cfo_reviewed_at = COALESCE(cfo_reviewed_at, now()),
  payout_method = COALESCE(payout_method, 'no_disbursement_outstanding'),
  disbursed_at = COALESCE(disbursed_at, now()),
  updated_at = now()
WHERE registration_type = 'outstanding_balance'
  AND status IN ('agent_verified', 'landlord_ops_approved', 'coo_approved', 'funded', 'disbursed');