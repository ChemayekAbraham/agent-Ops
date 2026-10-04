CREATE OR REPLACE FUNCTION public.agent_capture_contact_location(p_target_id uuid, p_target_role text, p_address jsonb, p_latitude double precision, p_longitude double precision, p_accuracy double precision DEFAULT NULL::double precision, p_landmark text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  INSERT INTO public.agent_visits (
    agent_id, tenant_id, latitude, longitude, accuracy, location_name
  ) VALUES (
    v_agent_id, p_target_id, p_latitude, p_longitude, p_accuracy,
    COALESCE(p_landmark, 'Location capture (' || p_target_role || ')')
  )
  RETURNING id INTO v_visit_id;

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

  -- system_events real columns: user_id, related_entity_type, related_entity_id, metadata
  INSERT INTO public.system_events (
    event_type, user_id, related_entity_type, related_entity_id, metadata
  )
  VALUES (
    'agent.contact_location_captured',
    v_agent_id,
    p_target_role,
    p_target_id,
    jsonb_build_object(
      'target_role', p_target_role,
      'target_id', p_target_id,
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
$function$;