CREATE OR REPLACE FUNCTION public.rent_requests_outstanding_pipeline_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
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

  -- Outstanding-balance requests never move money on-platform; block the
  -- disbursement-only stages but allow the review stages (agent ops →
  -- tenant ops → landlord ops) so the queue actually works.
  IF NEW.status IN ('coo_approved', 'funded', 'disbursed') THEN
    RAISE EXCEPTION
      'Outstanding-balance rent requests cannot enter the % stage. They go straight to active repayment after Landlord Ops approval.',
      NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Backward-compat shortcut: if an agent flips tenant_ops_approved -> agent_verified
  -- (legacy path), short-circuit straight to 'repaying'.
  IF OLD.status = 'tenant_ops_approved' AND NEW.status = 'agent_verified' THEN
    v_actor := COALESCE(NEW.agent_verified_by, OLD.agent_id, NEW.agent_id);

    NEW.status := 'repaying';
    NEW.agent_verified := TRUE;
    NEW.agent_verified_at := COALESCE(NEW.agent_verified_at, v_now);
    NEW.agent_verified_by := COALESCE(NEW.agent_verified_by, v_actor);

    NEW.landlord_ops_reviewed_by := COALESCE(NEW.landlord_ops_reviewed_by, v_actor);
    NEW.landlord_ops_reviewed_at := COALESCE(NEW.landlord_ops_reviewed_at, v_now);
    NEW.coo_reviewed_by := COALESCE(NEW.coo_reviewed_by, v_actor);
    NEW.coo_reviewed_at := COALESCE(NEW.coo_reviewed_at, v_now);
    NEW.cfo_reviewed_by := COALESCE(NEW.cfo_reviewed_by, v_actor);
    NEW.cfo_reviewed_at := COALESCE(NEW.cfo_reviewed_at, v_now);

    NEW.payout_method := COALESCE(NEW.payout_method, 'no_disbursement_outstanding');
    NEW.disbursed_at := COALESCE(NEW.disbursed_at, v_now);
    NEW.updated_at := v_now;
  END IF;

  -- New canonical path: Landlord Ops approves -> jump straight to 'repaying'.
  -- The tenant then surfaces in the agent's "owing" tab until the outstanding
  -- balance is fully cleared.
  IF OLD.status = 'tenant_ops_approved' AND NEW.status = 'landlord_ops_approved' THEN
    v_actor := COALESCE(NEW.landlord_ops_reviewed_by, OLD.agent_id, NEW.agent_id);

    NEW.status := 'repaying';

    -- Mark agent verification as satisfied (Landlord Ops sign-off implicitly
    -- confirms the tenant for the outstanding-balance branch).
    NEW.agent_verified := TRUE;
    NEW.agent_verified_at := COALESCE(NEW.agent_verified_at, v_now);
    NEW.agent_verified_by := COALESCE(NEW.agent_verified_by, OLD.agent_id, NEW.agent_id);

    NEW.landlord_ops_reviewed_by := COALESCE(NEW.landlord_ops_reviewed_by, v_actor);
    NEW.landlord_ops_reviewed_at := COALESCE(NEW.landlord_ops_reviewed_at, v_now);
    NEW.coo_reviewed_by := COALESCE(NEW.coo_reviewed_by, v_actor);
    NEW.coo_reviewed_at := COALESCE(NEW.coo_reviewed_at, v_now);
    NEW.cfo_reviewed_by := COALESCE(NEW.cfo_reviewed_by, v_actor);
    NEW.cfo_reviewed_at := COALESCE(NEW.cfo_reviewed_at, v_now);

    NEW.payout_method := COALESCE(NEW.payout_method, 'no_disbursement_outstanding');
    NEW.disbursed_at := COALESCE(NEW.disbursed_at, v_now);
    NEW.updated_at := v_now;
  END IF;

  RETURN NEW;
END;
$function$;