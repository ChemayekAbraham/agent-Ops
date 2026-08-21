CREATE OR REPLACE FUNCTION public.partner_ops_attach_proxy_and_forward(p_request_ids uuid[], p_proxy_agent_id uuid, p_comment text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_comment text := TRIM(COALESCE(p_comment, ''));
  v_ids uuid[];
  v_updated jsonb;
BEGIN
  IF NOT public.is_partner_ops(v_actor) THEN
    RAISE EXCEPTION 'Not authorised for Partner Operations' USING ERRCODE = '42501';
  END IF;
  IF p_request_ids IS NULL OR array_length(p_request_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'Select at least one rent request';
  END IF;
  IF char_length(v_comment) < 10 THEN
    RAISE EXCEPTION 'A note of at least 10 characters is required';
  END IF;
  IF p_proxy_agent_id IS NULL OR NOT public.is_approved_proxy_agent(p_proxy_agent_id) THEN
    RAISE EXCEPTION 'Only a verified proxy agent can be attached' USING ERRCODE = '42501';
  END IF;

  SELECT ARRAY_AGG(id) INTO v_ids
    FROM public.rent_requests
   WHERE id = ANY(p_request_ids)
     AND status = 'landlord_ops_approved'
     AND (registration_type IS NULL OR registration_type <> 'outstanding_balance');

  IF v_ids IS NULL THEN
    RAISE EXCEPTION 'None of the selected requests are awaiting Partner Operations';
  END IF;

  WITH upd AS (
    UPDATE public.rent_requests
       SET status = 'partner_ops_approved',
           proxy_agent_id = p_proxy_agent_id,
           partner_ops_reviewed_by = v_actor,
           partner_ops_reviewed_at = now(),
           partner_ops_comment = v_comment,
           updated_at = now()
     WHERE id = ANY(v_ids)
    RETURNING id, tenant_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'tenant_id', tenant_id)), '[]'::jsonb)
    INTO v_updated FROM upd;

  -- Tenant ↔ proxy agent relationship must be visible in the proxy directory.
  -- One active link per tenant: retire any link held by a different agent first.
  UPDATE public.proxy_agent_assignments a
     SET is_active = false, updated_at = now()
   WHERE a.beneficiary_role = 'tenant'
     AND a.agent_id <> p_proxy_agent_id
     AND a.beneficiary_id IN (
       SELECT (x->>'tenant_id')::uuid FROM jsonb_array_elements(v_updated) x
     );

  INSERT INTO public.proxy_agent_assignments
    (agent_id, beneficiary_id, beneficiary_role, assigned_by, reason, is_active, approval_status, approved_by, approved_at)
  SELECT DISTINCT p_proxy_agent_id, (x->>'tenant_id')::uuid, 'tenant', v_actor,
         'Attached during Partner Operations rent plan vetting', true, 'approved', v_actor, now()
    FROM jsonb_array_elements(v_updated) x
   WHERE (x->>'tenant_id') IS NOT NULL
  ON CONFLICT (agent_id, beneficiary_id) DO UPDATE
    SET beneficiary_role = 'tenant',
        is_active = true,
        approval_status = 'approved',
        approved_by = EXCLUDED.approved_by,
        approved_at = EXCLUDED.approved_at,
        updated_at = now();

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, reason, metadata)
  SELECT 'partner_ops_proxy_attached', 'rent_requests', (x->>'id')::uuid, v_actor, v_comment,
         jsonb_build_object('proxy_agent_id', p_proxy_agent_id, 'forwarded_to', 'coo')
    FROM jsonb_array_elements(v_updated) x;

  INSERT INTO public.system_events (event_type, user_id, metadata)
  SELECT 'rent_request_approved', (x->>'tenant_id')::uuid,
         jsonb_build_object(
           'stage', 'partner_ops_approved',
           'rent_request_id', (x->>'id')::uuid,
           'proxy_agent_id', p_proxy_agent_id,
           'reviewed_by', v_actor
         )
    FROM jsonb_array_elements(v_updated) x;

  RETURN jsonb_build_object(
    'updated', jsonb_array_length(v_updated),
    'rows', v_updated,
    'proxy_agent_id', p_proxy_agent_id
  );
END;
$function$;

-- Backfill tenant proxy links for rent plans already carrying a proxy agent.
INSERT INTO public.proxy_agent_assignments
  (agent_id, beneficiary_id, beneficiary_role, assigned_by, reason, is_active, approval_status, approved_by, approved_at)
SELECT DISTINCT r.proxy_agent_id, r.tenant_id, 'tenant', r.partner_ops_reviewed_by,
       'Backfilled from Partner Operations rent plan vetting', true, 'approved',
       r.partner_ops_reviewed_by, COALESCE(r.partner_ops_reviewed_at, now())
  FROM public.rent_requests r
 WHERE r.proxy_agent_id IS NOT NULL
   AND r.tenant_id IS NOT NULL
ON CONFLICT (agent_id, beneficiary_id) DO UPDATE
  SET beneficiary_role = 'tenant',
      is_active = true,
      approval_status = 'approved',
      updated_at = now();