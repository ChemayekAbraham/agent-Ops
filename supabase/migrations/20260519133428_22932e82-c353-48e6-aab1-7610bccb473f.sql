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
  v_tenant_name text;
  v_meta jsonb;
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
    IF v_outstanding <= 0 THEN CONTINUE; END IF;

    v_term_end := COALESCE(r.disbursed_at, r.created_at) + (r.duration_days || ' days')::interval;
    v_grace_end := v_term_end + interval '72 hours';
    IF now() < v_grace_end THEN CONTINUE; END IF;

    IF NOT COALESCE(r.agent_guarantor_consent, false) THEN CONTINUE; END IF;

    UPDATE public.rent_requests
       SET agent_liability_triggered = true,
           agent_liability_triggered_at = now(),
           agent_liability_amount = v_outstanding,
           agent_liability_reason = 'term_expired_plus_72h_grace',
           schedule_status = 'agent_liable',
           updated_at = now()
     WHERE id = r.id;

    INSERT INTO public.default_recovery_ledger
      (tenant_id, agent_id, rent_request_id, default_amount, status, notes)
    VALUES
      (r.tenant_id, r.agent_id, r.id, v_outstanding, 'agent_liable',
       'Auto-triggered: rent term expired + 72h grace, agent guarantor consent on file.');

    SELECT COALESCE(full_name, 'Tenant') INTO v_tenant_name
      FROM public.profiles WHERE id = r.tenant_id;

    v_meta := jsonb_build_object(
      'rent_request_id', r.id,
      'tenant_id', r.tenant_id,
      'tenant_name', v_tenant_name,
      'agent_id', r.agent_id,
      'outstanding', v_outstanding,
      'term_end', v_term_end,
      'grace_end', v_grace_end,
      'reason', 'term_expired_plus_72h_grace'
    );

    INSERT INTO public.system_events
      (event_type, user_id, related_entity_type, related_entity_id, metadata)
    VALUES
      ('rent.agent_liability_triggered', r.agent_id, 'rent_request', r.id, v_meta);

    -- Notify the agent (financial liability = critical, exempt from suppression)
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      r.agent_id,
      '⚠️ You are now liable for unpaid rent',
      'Tenant ' || v_tenant_name || ' did not repay UGX ' || to_char(v_outstanding, 'FM999,999,999')
        || ' within the term + 72h grace. Per your guarantor consent, this amount will be recovered from your commission wallet.',
      'agent_liability_triggered',
      v_meta
    );

    -- Notify platform admins (manager, cfo, coo, super_admin, operations)
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    SELECT ur.user_id,
           '⚠️ Agent marked liable for unpaid rent',
           'Rent request ' || substr(r.id::text, 1, 8) || ' auto-flagged. Outstanding: UGX '
             || to_char(v_outstanding, 'FM999,999,999') || '. Tenant: ' || v_tenant_name || '.',
           'agent_liability_triggered_admin',
           v_meta
      FROM public.user_roles ur
     WHERE ur.role IN ('manager','cfo','coo','super_admin','operations');

    rent_request_id := r.id;
    agent_id := r.agent_id;
    tenant_id := r.tenant_id;
    outstanding := v_outstanding;
    RETURN NEXT;
  END LOOP;

  RETURN;
END;
$$;