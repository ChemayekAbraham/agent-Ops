-- 1) When an agent marks a tenant not_paying, ping the ops inbox realtime feed
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

  UPDATE public.rent_requests
     SET agent_payment_status         = p_status,
         agent_payment_status_reason  = NULLIF(trim(coalesce(p_reason,'')),''),
         agent_payment_status_set_at  = now(),
         agent_payment_status_set_by  = v_caller
   WHERE id = p_rent_request_id
   RETURNING * INTO v_rr;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (
    v_caller,
    'rent.payment_status_changed',
    'rent_requests',
    p_rent_request_id,
    COALESCE(NULLIF(trim(coalesce(p_reason,'')),''), 'status_reset_paying'),
    jsonb_build_object('new_status', p_status, 'agent_id', v_rr.agent_id, 'tenant_id', v_rr.tenant_id)
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
      'reason', NULLIF(trim(coalesce(p_reason,'')),'')
    )
  );

  -- Surface to the Tenant Ops realtime inbox feed when an AGENT (not ops staff)
  -- marks a tenant inactive, so ops sees it prominently right away.
  IF p_status = 'not_paying' AND NOT v_is_staff THEN
    BEGIN
      INSERT INTO public.ops_inbox_events (scope, bucket, delta, reason, related_id)
      VALUES ('tenant', 'at_risk', 1, 'agent_marked_inactive', v_rr.tenant_id);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  -- Best-effort trust signal (don't fail RPC if helper is missing)
  BEGIN
    PERFORM public.capture_trust_signal(v_rr.agent_id, 'behavior', 'agent_rent_payment_status_changed', 1,
      jsonb_build_object('rent_request_id', p_rent_request_id, 'status', p_status));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN v_rr;
END;
$function$;

-- 2) RPC: recent tenants marked inactive by an agent (for the prominent ops banner)
CREATE OR REPLACE FUNCTION public.ops_recent_agent_inactivations(p_limit integer DEFAULT 25, p_since_hours integer DEFAULT 336)
 RETURNS TABLE(
   rent_request_id uuid,
   tenant_id uuid,
   tenant_name text,
   tenant_phone text,
   tenant_city text,
   agent_id uuid,
   agent_name text,
   reason text,
   marked_at timestamp with time zone
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT public.is_tenant_ops_staff(v_uid) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  RETURN QUERY
  SELECT
    rr.id,
    rr.tenant_id,
    tp.full_name,
    tp.phone,
    tp.city,
    rr.agent_id,
    ap.full_name,
    rr.agent_payment_status_reason,
    rr.agent_payment_status_set_at
  FROM public.rent_requests rr
  LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = rr.agent_payment_status_set_by
  WHERE rr.agent_payment_status = 'not_paying'
    AND rr.agent_payment_status_set_at >= now() - make_interval(hours => GREATEST(p_since_hours, 1))
    AND rr.agent_payment_status_set_by IS NOT NULL
    AND rr.agent_payment_status_set_by = rr.agent_id  -- set by the assigned agent, not ops staff
  ORDER BY rr.agent_payment_status_set_at DESC
  LIMIT GREATEST(LEAST(p_limit, 100), 1);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.ops_recent_agent_inactivations(integer, integer) TO authenticated;