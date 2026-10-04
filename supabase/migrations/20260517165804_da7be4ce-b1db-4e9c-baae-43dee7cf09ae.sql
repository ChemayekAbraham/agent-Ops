
-- 1. Bind a tenant (from a rent request) to a specific house
CREATE OR REPLACE FUNCTION public.landlord_ops_bind_tenant_to_house(
  p_house_id uuid,
  p_rent_request_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_house record;
  v_rr record;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (public.has_role(v_caller, 'landlord_ops') OR public.has_role(v_caller, 'manager')) THEN
    RAISE EXCEPTION 'Only Landlord Ops or Manager can bind tenants to houses';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  SELECT * INTO v_house FROM public.house_listings WHERE id = p_house_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'House not found'; END IF;

  SELECT * INTO v_rr FROM public.rent_requests WHERE id = p_rent_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rent request not found'; END IF;

  IF v_rr.landlord_id IS DISTINCT FROM v_house.landlord_id THEN
    RAISE EXCEPTION 'Rent request landlord does not match house landlord';
  END IF;

  UPDATE public.house_listings
    SET tenant_id = v_rr.tenant_id,
        status = 'occupied',
        updated_at = now()
    WHERE id = p_house_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_caller, 'tenant_bound_to_house', 'house_listings', p_house_id, p_reason,
          jsonb_build_object('rent_request_id', p_rent_request_id, 'tenant_id', v_rr.tenant_id,
                             'previous_tenant_id', v_house.tenant_id));

  INSERT INTO public.system_events (event_type, payload, source)
  VALUES ('house.tenant_bound',
          jsonb_build_object('house_id', p_house_id, 'tenant_id', v_rr.tenant_id,
                             'landlord_id', v_house.landlord_id, 'rent_request_id', p_rent_request_id,
                             'actor_id', v_caller),
          'landlord_ops_bind_tenant_to_house');

  RETURN jsonb_build_object('ok', true, 'house_id', p_house_id, 'tenant_id', v_rr.tenant_id);
END;
$$;
REVOKE ALL ON FUNCTION public.landlord_ops_bind_tenant_to_house(uuid, uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.landlord_ops_bind_tenant_to_house(uuid, uuid, text) TO authenticated;

-- 2. Remove a tenant from a house (absconded / vacated)
CREATE OR REPLACE FUNCTION public.landlord_ops_remove_tenant_from_house(
  p_house_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_house record;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (public.has_role(v_caller, 'landlord_ops') OR public.has_role(v_caller, 'manager')) THEN
    RAISE EXCEPTION 'Only Landlord Ops or Manager can remove tenants from houses';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  SELECT * INTO v_house FROM public.house_listings WHERE id = p_house_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'House not found'; END IF;

  UPDATE public.house_listings
    SET tenant_id = NULL,
        status = 'available',
        updated_at = now()
    WHERE id = p_house_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_caller, 'tenant_removed_from_house', 'house_listings', p_house_id, p_reason,
          jsonb_build_object('previous_tenant_id', v_house.tenant_id, 'landlord_id', v_house.landlord_id));

  INSERT INTO public.system_events (event_type, payload, source)
  VALUES ('house.tenant_removed',
          jsonb_build_object('house_id', p_house_id, 'previous_tenant_id', v_house.tenant_id,
                             'landlord_id', v_house.landlord_id, 'actor_id', v_caller),
          'landlord_ops_remove_tenant_from_house');

  RETURN jsonb_build_object('ok', true, 'house_id', p_house_id);
END;
$$;
REVOKE ALL ON FUNCTION public.landlord_ops_remove_tenant_from_house(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.landlord_ops_remove_tenant_from_house(uuid, text) TO authenticated;

-- 3. Reassign the managing agent on a house
CREATE OR REPLACE FUNCTION public.reassign_house_agent(
  p_house_id uuid,
  p_new_agent_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_house record;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (public.has_role(v_caller, 'landlord_ops') OR public.has_role(v_caller, 'manager')) THEN
    RAISE EXCEPTION 'Only Landlord Ops or Manager can reassign the house agent';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;
  IF NOT public.has_role(p_new_agent_id, 'agent') THEN
    RAISE EXCEPTION 'Target user is not an agent';
  END IF;

  SELECT * INTO v_house FROM public.house_listings WHERE id = p_house_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'House not found'; END IF;

  UPDATE public.house_listings SET agent_id = p_new_agent_id, updated_at = now() WHERE id = p_house_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_caller, 'house_agent_reassigned', 'house_listings', p_house_id, p_reason,
          jsonb_build_object('previous_agent_id', v_house.agent_id, 'new_agent_id', p_new_agent_id));

  INSERT INTO public.system_events (event_type, payload, source)
  VALUES ('house.agent_reassigned',
          jsonb_build_object('house_id', p_house_id, 'previous_agent_id', v_house.agent_id,
                             'new_agent_id', p_new_agent_id, 'actor_id', v_caller),
          'reassign_house_agent');

  RETURN jsonb_build_object('ok', true, 'house_id', p_house_id, 'agent_id', p_new_agent_id);
END;
$$;
REVOKE ALL ON FUNCTION public.reassign_house_agent(uuid, uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.reassign_house_agent(uuid, uuid, text) TO authenticated;

-- 4. Reassign the agent on a tenant's rent request
CREATE OR REPLACE FUNCTION public.reassign_rent_request_agent(
  p_rent_request_id uuid,
  p_new_agent_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_rr record;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (public.has_role(v_caller, 'landlord_ops') OR public.has_role(v_caller, 'manager')) THEN
    RAISE EXCEPTION 'Only Landlord Ops or Manager can reassign the rent request agent';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;
  IF NOT public.has_role(p_new_agent_id, 'agent') THEN
    RAISE EXCEPTION 'Target user is not an agent';
  END IF;

  SELECT * INTO v_rr FROM public.rent_requests WHERE id = p_rent_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rent request not found'; END IF;

  UPDATE public.rent_requests SET agent_id = p_new_agent_id, updated_at = now() WHERE id = p_rent_request_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_caller, 'rent_request_agent_reassigned', 'rent_requests', p_rent_request_id, p_reason,
          jsonb_build_object('previous_agent_id', v_rr.agent_id, 'new_agent_id', p_new_agent_id,
                             'tenant_id', v_rr.tenant_id));

  INSERT INTO public.system_events (event_type, payload, source)
  VALUES ('rent_request.agent_reassigned',
          jsonb_build_object('rent_request_id', p_rent_request_id, 'tenant_id', v_rr.tenant_id,
                             'previous_agent_id', v_rr.agent_id, 'new_agent_id', p_new_agent_id,
                             'actor_id', v_caller),
          'reassign_rent_request_agent');

  RETURN jsonb_build_object('ok', true, 'rent_request_id', p_rent_request_id, 'agent_id', p_new_agent_id);
END;
$$;
REVOKE ALL ON FUNCTION public.reassign_rent_request_agent(uuid, uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.reassign_rent_request_agent(uuid, uuid, text) TO authenticated;
