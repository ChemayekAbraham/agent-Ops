-- 1) Relationship check: agent ↔ target (tenant, landlord, partner, sub-agent)
CREATE OR REPLACE FUNCTION public.has_agent_contact_relationship(
  _agent_id uuid,
  _target_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    -- Tenant managed by agent (managing_agent_id)
    SELECT 1 FROM public.profiles p
      WHERE p.id = _target_id AND p.managing_agent_id = _agent_id
    UNION ALL
    -- Tenant referred by agent (direct referral)
    SELECT 1 FROM public.profiles p
      WHERE p.id = _target_id AND p.referrer_id = _agent_id
    UNION ALL
    -- Tenant linked via rent_requests assigned to agent
    SELECT 1 FROM public.rent_requests r
      WHERE r.tenant_id = _target_id AND r.assigned_agent_id = _agent_id
    UNION ALL
    -- Landlord assignment
    SELECT 1 FROM public.agent_landlord_assignments a
      WHERE a.agent_id = _agent_id AND a.landlord_id = _target_id AND a.status = 'active'
    UNION ALL
    -- Landlord profile via landlords table (if landlords.id = profile id, otherwise via owner)
    SELECT 1 FROM public.landlords l
      JOIN public.agent_landlord_assignments a ON a.landlord_id = l.id
      WHERE a.agent_id = _agent_id AND l.id = _target_id
    UNION ALL
    -- Proxy partner / supporter (agent acts as proxy for beneficiary)
    SELECT 1 FROM public.proxy_agent_assignments pa
      WHERE pa.agent_id = _agent_id AND pa.beneficiary_id = _target_id AND pa.is_active = true
  );
$$;

GRANT EXECUTE ON FUNCTION public.has_agent_contact_relationship(uuid, uuid) TO authenticated;

-- 2) Capture location action
CREATE OR REPLACE FUNCTION public.agent_capture_contact_location(
  p_target_id uuid,
  p_target_role text,
  p_address jsonb,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision DEFAULT NULL,
  p_landmark text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent_id uuid := auth.uid();
  v_visit_id uuid;
BEGIN
  IF v_agent_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.has_agent_contact_relationship(v_agent_id, p_target_id) THEN
    RAISE EXCEPTION 'Agent does not have a managing relationship with this contact';
  END IF;

  IF p_latitude IS NULL OR p_longitude IS NULL THEN
    RAISE EXCEPTION 'GPS coordinates are required';
  END IF;

  -- Update profile address fields
  UPDATE public.profiles SET
    continent  = COALESCE(NULLIF(p_address->>'continent', ''), continent),
    country    = COALESCE(NULLIF(p_address->>'country', ''),   country),
    region     = COALESCE(NULLIF(p_address->>'region', ''),    region),
    district   = COALESCE(NULLIF(p_address->>'district', ''),  district),
    city       = COALESCE(NULLIF(p_address->>'city', ''),      city),
    town       = COALESCE(NULLIF(p_address->>'town', ''),      town),
    sub_county = COALESCE(NULLIF(p_address->>'sub_county', ''),sub_county),
    parish     = COALESCE(NULLIF(p_address->>'parish', ''),    parish),
    village    = COALESCE(NULLIF(p_address->>'village', ''),   village),
    landmark   = COALESCE(NULLIF(p_landmark, ''),              landmark),
    residence_lat = p_latitude,
    residence_lng = p_longitude,
    residence_updated_at = now(),
    address_complete = true,
    address_completed_at = now(),
    updated_at = now()
  WHERE id = p_target_id;

  -- Record agent field visit (geo + audit trail)
  INSERT INTO public.agent_visits (
    agent_id, tenant_id, latitude, longitude, accuracy, location_name
  ) VALUES (
    v_agent_id, p_target_id, p_latitude, p_longitude, p_accuracy,
    COALESCE(p_landmark, 'Location capture (' || p_target_role || ')')
  )
  RETURNING id INTO v_visit_id;

  -- Bump target's Welile Trust Score via verification+GPS signal
  PERFORM public.capture_trust_signal(
    p_target_id,
    'agent_location_capture',
    'residence',
    COALESCE(p_landmark, 'Captured by agent'),
    p_latitude,
    p_longitude,
    p_accuracy,
    'Agent ' || v_agent_id::text || ' captured contact location'
  );

  -- Emit system event
  INSERT INTO public.system_events (event_type, actor_id, subject_id, payload)
  VALUES (
    'agent.contact_location_captured',
    v_agent_id,
    p_target_id,
    jsonb_build_object(
      'target_role', p_target_role,
      'visit_id', v_visit_id,
      'lat', p_latitude,
      'lng', p_longitude,
      'accuracy', p_accuracy
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'visit_id', v_visit_id,
    'target_id', p_target_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.agent_capture_contact_location(uuid, text, jsonb, double precision, double precision, double precision, text) TO authenticated;