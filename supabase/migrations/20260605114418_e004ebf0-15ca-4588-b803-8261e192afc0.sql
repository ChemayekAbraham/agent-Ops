CREATE OR REPLACE FUNCTION public.agent_set_rent_payment_status(p_rent_request_id uuid, p_status text, p_reason text)
 RETURNS rent_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller   uuid := auth.uid();
  v_rr       public.rent_requests;
  v_is_staff boolean;
  v_freed    integer := 0;
  v_restored integer := 0;
  v_old_status text;
  v_outstanding numeric := 0;
  v_daily numeric := 0;
  v_out_before numeric := 0;
  v_out_after  numeric := 0;
  v_daily_before numeric := 0;
  v_daily_after  numeric := 0;
  v_clean_reason text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_status NOT IN ('paying','not_paying') THEN
    RAISE EXCEPTION 'INVALID_STATUS: must be paying or not_paying'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_rr FROM public.rent_requests WHERE id = p_rent_request_id FOR UPDATE;
  IF v_rr.id IS NULL THEN
    RAISE EXCEPTION 'RENT_REQUEST_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  v_is_staff := public.has_role(v_caller, 'manager')
             OR public.has_role(v_caller, 'operations')
             OR public.has_role(v_caller, 'coo')
             OR public.has_role(v_caller, 'super_admin');

  IF v_rr.agent_id <> v_caller AND NOT v_is_staff THEN
    RAISE EXCEPTION 'FORBIDDEN: only the assigned agent or ops staff can change payment status'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_status = 'not_paying' AND (p_reason IS NULL OR length(trim(p_reason)) < 10) THEN
    RAISE EXCEPTION 'REASON_REQUIRED: provide at least 10 characters explaining why this tenant is not paying'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Snapshot pre-change values for the audit trail
  v_old_status  := COALESCE(v_rr.agent_payment_status, 'paying');
  v_outstanding := GREATEST(COALESCE(v_rr.total_repayment, 0) - COALESCE(v_rr.amount_repaid, 0), 0);
  v_daily       := COALESCE(v_rr.daily_repayment, 0);
  v_clean_reason := NULLIF(trim(coalesce(p_reason,'')),'');

  -- before/after represent this tenant's CONTRIBUTION to the agent's
  -- outstanding balance and daily collection target.
  IF p_status = 'not_paying' THEN
    v_out_before := v_outstanding; v_out_after := 0;
    v_daily_before := v_daily;     v_daily_after := 0;
  ELSE
    v_out_before := 0; v_out_after := v_outstanding;
    v_daily_before := 0; v_daily_after := v_daily;
  END IF;

  UPDATE public.rent_requests
     SET agent_payment_status         = p_status,
         agent_payment_status_reason  = v_clean_reason,
         agent_payment_status_set_at  = now(),
         agent_payment_status_set_by  = v_caller
   WHERE id = p_rent_request_id
   RETURNING * INTO v_rr;

  -- ===== Priority move: free / restore the tenant's house listing =====
  IF p_status = 'not_paying' THEN
    WITH freed AS (
      UPDATE public.house_listings
         SET suspended_tenant_id = tenant_id,
             tenant_id           = NULL,
             status              = 'available'
       WHERE tenant_id = v_rr.tenant_id
       RETURNING 1
    )
    SELECT count(*) INTO v_freed FROM freed;

    UPDATE public.landlords
       SET tenant_id = NULL
     WHERE tenant_id = v_rr.tenant_id;
  ELSE
    WITH restored AS (
      UPDATE public.house_listings
         SET tenant_id           = suspended_tenant_id,
             suspended_tenant_id = NULL,
             status              = 'occupied'
       WHERE suspended_tenant_id = v_rr.tenant_id
       RETURNING 1
    )
    SELECT count(*) INTO v_restored FROM restored;

    IF v_rr.landlord_id IS NOT NULL THEN
      UPDATE public.landlords
         SET tenant_id = v_rr.tenant_id
       WHERE id = v_rr.landlord_id
         AND tenant_id IS NULL;
    END IF;
  END IF;

  -- ===== Audit trail: before/after amounts on every status move =====
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_caller,
    CASE WHEN p_status = 'not_paying'
         THEN 'rent.tenant_marked_not_paying'
         ELSE 'rent.tenant_restored_paying' END,
    'rent_requests',
    p_rent_request_id::text,
    jsonb_build_object(
      'reason', COALESCE(v_clean_reason, 'status_reset_paying'),
      'old_status', v_old_status,
      'new_status', p_status,
      'agent_id', v_rr.agent_id,
      'tenant_id', v_rr.tenant_id,
      'houses_freed', v_freed,
      'houses_restored', v_restored,
      'priority_move', CASE WHEN p_status = 'not_paying'
                           THEN 'placed_to_priority_1'
                           ELSE 'priority_1_to_placed' END,
      'outstanding_before', v_out_before,
      'outstanding_after',  v_out_after,
      'outstanding_delta',  v_out_after - v_out_before,
      'daily_target_before', v_daily_before,
      'daily_target_after',  v_daily_after,
      'daily_target_delta',  v_daily_after - v_daily_before,
      'currency', 'UGX'
    )
  );

  INSERT INTO public.system_events (event_type, actor_id, payload)
  VALUES (
    'agent.rent.payment_status_changed',
    v_caller,
    jsonb_build_object(
      'rent_request_id', p_rent_request_id,
      'agent_id', v_rr.agent_id,
      'tenant_id', v_rr.tenant_id,
      'status', p_status,
      'houses_freed', v_freed,
      'houses_restored', v_restored,
      'outstanding_before', v_out_before,
      'outstanding_after', v_out_after,
      'daily_target_before', v_daily_before,
      'daily_target_after', v_daily_after,
      'reason', v_clean_reason
    )
  );

  IF p_status = 'not_paying' AND NOT v_is_staff THEN
    BEGIN
      INSERT INTO public.ops_inbox_events (scope, bucket, delta, reason, related_id)
      VALUES ('tenant', 'at_risk', 1, 'agent_marked_inactive', v_rr.tenant_id);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  BEGIN
    PERFORM public.capture_trust_signal(v_rr.agent_id, 'behavior', 'agent_rent_payment_status_changed', 1,
      jsonb_build_object('rent_request_id', p_rent_request_id, 'status', p_status));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN v_rr;
END;
$function$;