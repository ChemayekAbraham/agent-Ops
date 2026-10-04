CREATE OR REPLACE FUNCTION public.ops_transfer_tenant_agent(
  p_rent_request_id uuid,
  p_new_agent_id uuid DEFAULT NULL,
  p_listing_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_old_agent uuid;
  v_tenant uuid;
  v_reason text := COALESCE(NULLIF(trim(p_reason), ''), 'Tenant Ops agent transfer from All Tenants');
  v_found boolean;
  v_listing_tenant uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  IF NOT (
    public.has_role(v_actor, 'tenant_ops')
    OR public.has_role(v_actor, 'agent_ops')
    OR public.has_role(v_actor, 'landlord_ops')
    OR public.has_role(v_actor, 'partner_ops')
    OR public.has_role(v_actor, 'operations')
    OR public.has_role(v_actor, 'coo')
    OR public.has_role(v_actor, 'ceo')
    OR public.has_role(v_actor, 'manager')
    OR public.has_role(v_actor, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Only operations staff may transfer a tenant to another agent' USING ERRCODE = '42501';
  END IF;

  IF p_new_agent_id IS NULL AND p_listing_id IS NULL THEN
    RAISE EXCEPTION 'Pick an agent or a property' USING ERRCODE = '22023';
  END IF;

  SELECT true, COALESCE(assigned_agent_id, agent_id), tenant_id
    INTO v_found, v_old_agent, v_tenant
    FROM public.rent_requests
   WHERE id = p_rent_request_id
     FOR UPDATE;

  IF NOT COALESCE(v_found, false) THEN
    RAISE EXCEPTION 'Rent request not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_new_agent_id IS NOT NULL AND p_new_agent_id IS DISTINCT FROM v_old_agent THEN
    UPDATE public.rent_requests
       SET agent_id = p_new_agent_id,
           assigned_agent_id = p_new_agent_id,
           updated_at = now()
     WHERE id = p_rent_request_id;

    -- Append-only history. Existing rows are never touched.
    IF v_old_agent IS NOT NULL AND v_tenant IS NOT NULL THEN
      INSERT INTO public.tenant_reassignment_audit (
        rent_request_id, tenant_id, old_agent_id, new_agent_id, reason, actor_id
      ) VALUES (
        p_rent_request_id, v_tenant, v_old_agent, p_new_agent_id, v_reason, v_actor
      );
    END IF;

    INSERT INTO public.audit_logs (
      user_id, action_type, table_name, record_id, reason, old_values, new_values, metadata
    ) VALUES (
      v_actor, 'tenant_agent_transfer', 'rent_requests', p_rent_request_id, v_reason,
      jsonb_build_object('agent_id', v_old_agent),
      jsonb_build_object('agent_id', p_new_agent_id),
      jsonb_build_object('tenant_id', v_tenant, 'listing_id', p_listing_id)
    );

    BEGIN
      INSERT INTO public.system_events (event_type, actor_id, subject_id, payload)
      VALUES (
        'role_changed', v_actor, v_tenant,
        jsonb_build_object(
          'kind', 'tenant.agent_transferred',
          'rent_request_id', p_rent_request_id,
          'old_agent_id', v_old_agent,
          'new_agent_id', p_new_agent_id,
          'reason', v_reason
        )
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  IF p_listing_id IS NOT NULL THEN
    SELECT tenant_id INTO v_listing_tenant FROM public.house_listings WHERE id = p_listing_id;

    UPDATE public.house_listings
       SET agent_id = COALESCE(p_new_agent_id, agent_id),
           tenant_id = CASE
             WHEN v_listing_tenant IS NULL AND v_tenant IS NOT NULL THEN v_tenant
             ELSE tenant_id
           END,
           updated_at = now()
     WHERE id = p_listing_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'rent_request_id', p_rent_request_id,
    'old_agent_id', v_old_agent,
    'new_agent_id', p_new_agent_id,
    'listing_id', p_listing_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ops_transfer_tenant_agent(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_transfer_tenant_agent(uuid, uuid, uuid, text) TO authenticated;