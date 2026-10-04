DROP FUNCTION IF EXISTS public.agent_capture_contact_location(uuid, text, jsonb, double precision, double precision, double precision, text);

CREATE OR REPLACE FUNCTION public.agent_capture_contact_location(
  p_target_id uuid,
  p_target_role text,
  p_address jsonb,
  p_latitude double precision DEFAULT NULL::double precision,
  p_longitude double precision DEFAULT NULL::double precision,
  p_accuracy double precision DEFAULT NULL::double precision,
  p_landmark text DEFAULT NULL::text,
  p_village_id integer DEFAULT NULL::integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_id uuid := auth.uid();
  v_visit_id uuid;
  v_bonus jsonb;
  v_addr jsonb := COALESCE(p_address, '{}'::jsonb);
  v_village_id integer := p_village_id;
BEGIN
  IF v_agent_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.has_agent_contact_relationship(v_agent_id, p_target_id) THEN
    RAISE EXCEPTION 'Agent does not have a managing relationship with this contact';
  END IF;

  -- Approved dataset is authoritative: derive the whole chain server-side.
  IF v_village_id IS NOT NULL THEN
    SELECT jsonb_build_object(
             'continent', 'Africa',
             'country', 'Uganda',
             'region', d.region,
             'district', d.name,
             'county', c.name,
             'sub_county', s.name,
             'parish', pa.name,
             'village', v.name
           )
      INTO v_addr
      FROM public.ug_villages v
      JOIN public.ug_parishes pa ON pa.id = v.parish_id
      JOIN public.ug_subcounties s ON s.id = pa.subcounty_id
      JOIN public.ug_counties c ON c.id = s.county_id
      JOIN public.ug_districts d ON d.id = c.district_id
     WHERE v.id = v_village_id;

    IF v_addr IS NULL THEN
      RAISE EXCEPTION 'Unknown village id %', v_village_id;
    END IF;

    -- Keep the caller's free-text city/town extras, dataset fields win.
    v_addr := COALESCE(p_address, '{}'::jsonb) || v_addr;
  END IF;

  UPDATE public.profiles SET
    continent  = COALESCE(NULLIF(v_addr->>'continent', ''), continent),
    country    = COALESCE(NULLIF(v_addr->>'country', ''),   country),
    region     = COALESCE(NULLIF(v_addr->>'region', ''),    region),
    district   = COALESCE(NULLIF(v_addr->>'district', ''),  district),
    city       = COALESCE(NULLIF(v_addr->>'city', ''),      city),
    town       = COALESCE(NULLIF(v_addr->>'town', ''),      town),
    sub_county = COALESCE(NULLIF(v_addr->>'sub_county', ''),sub_county),
    parish     = COALESCE(NULLIF(v_addr->>'parish', ''),    parish),
    village    = COALESCE(NULLIF(v_addr->>'village', ''),   village),
    ug_village_id = COALESCE(v_village_id, ug_village_id),
    landmark   = COALESCE(NULLIF(p_landmark, ''),           landmark),
    residence_lat = COALESCE(p_latitude, residence_lat),
    residence_lng = COALESCE(p_longitude, residence_lng),
    residence_updated_at = CASE WHEN p_latitude IS NOT NULL THEN now() ELSE residence_updated_at END,
    address_complete = true,
    address_completed_at = now(),
    updated_at = now()
  WHERE id = p_target_id;

  IF p_latitude IS NOT NULL AND p_longitude IS NOT NULL THEN
    INSERT INTO public.agent_visits (
      agent_id, tenant_id, latitude, longitude, accuracy, location_name
    ) VALUES (
      v_agent_id, p_target_id, p_latitude, p_longitude, p_accuracy,
      COALESCE(p_landmark, 'Location capture (' || p_target_role || ')')
    )
    RETURNING id INTO v_visit_id;

    BEGIN
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
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  BEGIN
    v_bonus := public.credit_agent_event_bonus(
      v_agent_id,
      'contact_location_capture',
      p_target_id,
      'loc:' || p_target_id::text
    );
  EXCEPTION WHEN OTHERS THEN
    v_bonus := jsonb_build_object('status', 'error', 'message', SQLERRM);
  END;

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
      'accuracy', p_accuracy,
      'ug_village_id', v_village_id,
      'bonus', v_bonus
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'visit_id', v_visit_id,
    'target_id', p_target_id,
    'ug_village_id', v_village_id,
    'bonus', v_bonus
  );
END;
$function$;