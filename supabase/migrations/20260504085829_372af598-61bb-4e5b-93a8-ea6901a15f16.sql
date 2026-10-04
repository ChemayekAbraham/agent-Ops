-- Update the outstanding-balance rent pipeline guard so that agent
-- verification no longer short-circuits status to 'completed'. Instead,
-- the request enters the active repayment cycle ('repaying') and can
-- only become 'completed' when amount_repaid >= total_repayment, just
-- like every other rent request.

CREATE OR REPLACE FUNCTION public.rent_requests_outstanding_pipeline_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
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

  -- Block the funding/disbursement-only states for this branch — outstanding
  -- balance rents do not move money on-platform, so they must skip those gates.
  IF NEW.status IN ('landlord_ops_approved', 'coo_approved', 'funded', 'disbursed') THEN
    RAISE EXCEPTION
      'Outstanding-balance rent requests cannot enter the % stage. They go straight to active repayment after agent verification.',
      NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- When agent moves it from tenant_ops_approved -> agent_verified,
  -- short-circuit straight to the active repayment cycle ('repaying') and
  -- stamp downstream reviewer columns with the agent so audit history stays
  -- well-formed. The status will only flip to 'completed' once the tenant
  -- has actually fully repaid (handled by repayment functions / triggers).
  IF OLD.status = 'tenant_ops_approved' AND NEW.status = 'agent_verified' THEN
    v_actor := COALESCE(NEW.agent_verified_by, OLD.agent_id, NEW.agent_id);

    NEW.status := 'repaying';
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

-- One-off repair: the 11 outstanding-balance rent records that the previous
-- trigger forced to 'completed' even though the tenant has not paid. Move
-- them to 'repaying' so the agent / tenant balance views show them as
-- active rent plans, not as fully-repaid history.
UPDATE public.rent_requests
   SET status = 'repaying',
       updated_at = now()
 WHERE status = 'completed'
   AND registration_type = 'outstanding_balance'
   AND COALESCE(amount_repaid, 0) < COALESCE(total_repayment, 0);
