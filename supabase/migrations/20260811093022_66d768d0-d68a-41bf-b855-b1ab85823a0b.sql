CREATE OR REPLACE FUNCTION public.ops_transfer_pipeline_request_agent(
  p_request_id uuid,
  p_to_agent_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_req record;
  v_from uuid;
  v_is_agent boolean;
  v_subs int := 0;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (
    public.has_role(v_actor, 'manager') OR
    public.has_role(v_actor, 'super_admin') OR
    public.has_role(v_actor, 'coo') OR
    public.has_role(v_actor, 'ceo') OR
    public.has_role(v_actor, 'cfo') OR
    public.has_role(v_actor, 'operations') OR
    public.has_role(v_actor, 'agent_ops') OR
    public.has_role(v_actor, 'tenant_ops')
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions to transfer a pipeline tenant';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_req FROM public.rent_requests WHERE id = p_request_id;
  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'Rent request not found';
  END IF;

  IF v_req.status NOT IN ('pending','agent_ops_approved','tenant_ops_approved','landlord_ops_approved','coo_approved') THEN
    RAISE EXCEPTION 'Transfer only allowed while the request is still in the approval pipeline (current status: %)', v_req.status;
  END IF;

  v_from := COALESCE(v_req.assigned_agent_id, v_req.agent_id);
  IF v_from = p_to_agent_id THEN
    RAISE EXCEPTION 'This request is already attached to that agent';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_to_agent_id AND role IN ('agent','senior_agent','sub_agent')
  ) INTO v_is_agent;
  IF NOT v_is_agent THEN
    RAISE EXCEPTION 'Target user is not an agent';
  END IF;

  UPDATE public.rent_requests
     SET agent_id = p_to_agent_id,
         assigned_agent_id = p_to_agent_id,
         updated_at = now()
   WHERE id = p_request_id;

  UPDATE public.subscription_charges
     SET agent_id = p_to_agent_id
   WHERE tenant_id = v_req.tenant_id
     AND status = 'active'
     AND (agent_id = v_from OR agent_id IS NULL);
  GET DIAGNOSTICS v_subs = ROW_COUNT;

  INSERT INTO public.tenant_transfers (
    tenant_id, from_agent_id, to_agent_id, transferred_by, reason,
    flag_type, rent_requests_updated, subscriptions_updated
  ) VALUES (
    v_req.tenant_id, v_from, p_to_agent_id, v_actor, trim(p_reason),
    'pipeline_transfer', 1, v_subs
  );

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_actor, 'pipeline_tenant_transfer', 'rent_requests', p_request_id,
    jsonb_build_object(
      'tenant_id', v_req.tenant_id,
      'from_agent_id', v_from,
      'to_agent_id', p_to_agent_id,
      'status_at_transfer', v_req.status,
      'reason', trim(p_reason),
      'subscriptions_updated', v_subs
    )
  );

  BEGIN
    INSERT INTO public.notifications (user_id, title, message, type)
    VALUES
      (p_to_agent_id, 'Tenant Transferred To You', 'A pipeline tenant has been transferred to you. All commissions, repayments and renewals now attach to your account.', 'system'),
      (v_from, 'Tenant Reassigned', 'A pipeline tenant has been reassigned to another agent. Reason: ' || trim(p_reason), 'system');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'request_id', p_request_id,
    'from_agent_id', v_from,
    'to_agent_id', p_to_agent_id,
    'subscriptions_updated', v_subs
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ops_transfer_pipeline_request_agent(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_transfer_pipeline_request_agent(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_transfer_pipeline_request_agent(uuid, uuid, text) TO service_role;