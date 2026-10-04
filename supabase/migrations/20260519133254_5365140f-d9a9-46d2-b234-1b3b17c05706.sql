-- 1. Add liability tracking columns
ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS agent_liability_triggered boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_liability_triggered_at timestamptz,
  ADD COLUMN IF NOT EXISTS agent_liability_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS agent_liability_reason text;

CREATE INDEX IF NOT EXISTS idx_rent_requests_liability_scan
  ON public.rent_requests (status, agent_liability_triggered)
  WHERE status = 'disbursed' AND agent_liability_triggered = false;

-- 2. Allow 'agent_liable' schedule_status (no CHECK exists today, but document)
-- (schedule_status is free text, no constraint to modify.)

-- 3. Workflow function
CREATE OR REPLACE FUNCTION public.trigger_agent_liability_for_unpaid_rents()
RETURNS TABLE(
  rent_request_id uuid,
  agent_id uuid,
  tenant_id uuid,
  outstanding numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_outstanding numeric;
  v_term_end timestamptz;
  v_grace_end timestamptz;
BEGIN
  FOR r IN
    SELECT rr.id, rr.tenant_id, rr.agent_id, rr.rent_amount,
           rr.total_repayment, rr.amount_repaid, rr.duration_days,
           rr.disbursed_at, rr.created_at,
           rr.agent_guarantor_consent
    FROM public.rent_requests rr
    WHERE rr.status = 'disbursed'
      AND rr.agent_liability_triggered = false
      AND rr.agent_id IS NOT NULL
  LOOP
    v_outstanding := GREATEST(0, COALESCE(r.total_repayment, 0) - COALESCE(r.amount_repaid, 0));
    IF v_outstanding <= 0 THEN
      CONTINUE;
    END IF;

    v_term_end := COALESCE(r.disbursed_at, r.created_at) + (r.duration_days || ' days')::interval;
    v_grace_end := v_term_end + interval '72 hours';

    IF now() < v_grace_end THEN
      CONTINUE;
    END IF;

    -- Guard: only auto-trigger when the agent accepted guarantor responsibility.
    -- (Without consent, liability requires manual ops review.)
    IF NOT COALESCE(r.agent_guarantor_consent, false) THEN
      CONTINUE;
    END IF;

    -- Mark agent liable on the rent request
    UPDATE public.rent_requests
       SET agent_liability_triggered = true,
           agent_liability_triggered_at = now(),
           agent_liability_amount = v_outstanding,
           agent_liability_reason = 'term_expired_plus_72h_grace',
           schedule_status = 'agent_liable',
           updated_at = now()
     WHERE id = r.id;

    -- Open a default-recovery record tied to the agent
    INSERT INTO public.default_recovery_ledger
      (tenant_id, agent_id, rent_request_id, default_amount, status, notes)
    VALUES
      (r.tenant_id, r.agent_id, r.id, v_outstanding, 'agent_liable',
       'Auto-triggered: rent term expired + 72h grace, agent guarantor consent on file.');

    -- Emit system event (75% Event-Based Architecture)
    INSERT INTO public.system_events
      (event_type, user_id, related_entity_type, related_entity_id, metadata)
    VALUES
      ('rent.agent_liability_triggered', r.agent_id, 'rent_request', r.id,
       jsonb_build_object(
         'tenant_id', r.tenant_id,
         'agent_id', r.agent_id,
         'outstanding', v_outstanding,
         'term_end', v_term_end,
         'grace_end', v_grace_end,
         'reason', 'term_expired_plus_72h_grace'
       ));

    rent_request_id := r.id;
    agent_id := r.agent_id;
    tenant_id := r.tenant_id;
    outstanding := v_outstanding;
    RETURN NEXT;
  END LOOP;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.trigger_agent_liability_for_unpaid_rents() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trigger_agent_liability_for_unpaid_rents() TO service_role;