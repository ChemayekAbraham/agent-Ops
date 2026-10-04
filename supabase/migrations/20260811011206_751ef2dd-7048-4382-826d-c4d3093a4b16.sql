CREATE OR REPLACE FUNCTION public.ops_update_user_location(p_user_id uuid, p_address jsonb, p_latitude double precision, p_longitude double precision, p_accuracy double precision, p_reason text, p_has_smartphone boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_is_ops boolean;
  v_is_agent_owner boolean;
  v_village_id integer := NULLIF(p_address->>'ug_village_id', '')::integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  v_is_ops := public.is_ops_role(v_actor);
  v_is_agent_owner := public.has_agent_contact_relationship(v_actor, p_user_id);
  IF NOT (v_is_ops OR v_is_agent_owner) THEN
    RAISE EXCEPTION 'Not authorised to edit this user';
  END IF;

  UPDATE public.profiles SET
    continent  = COALESCE(NULLIF(p_address->>'continent', ''),  continent),
    country    = COALESCE(NULLIF(p_address->>'country', ''),    country),
    region     = COALESCE(NULLIF(p_address->>'region', ''),     region),
    district   = COALESCE(NULLIF(p_address->>'district', ''),   district),
    city       = COALESCE(NULLIF(p_address->>'city', ''),       city),
    town       = COALESCE(NULLIF(p_address->>'town', ''),       town),
    sub_county = COALESCE(NULLIF(p_address->>'sub_county', ''), sub_county),
    parish     = COALESCE(NULLIF(p_address->>'parish', ''),     parish),
    village    = COALESCE(NULLIF(p_address->>'village', ''),    village),
    landmark   = COALESCE(NULLIF(p_address->>'landmark', ''),   landmark),
    ug_village_id = COALESCE(v_village_id, ug_village_id),
    residence_lat = COALESCE(p_latitude,  residence_lat),
    residence_lng = COALESCE(p_longitude, residence_lng),
    residence_updated_at = CASE WHEN p_latitude IS NOT NULL THEN now() ELSE residence_updated_at END,
    address_complete = true,
    address_completed_at = COALESCE(address_completed_at, now()),
    has_smartphone = COALESCE(p_has_smartphone, has_smartphone),
    updated_at = now()
  WHERE id = p_user_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_actor, 'ops.update_user_location', 'profiles', p_user_id::text,
    jsonb_build_object(
      'reason', p_reason, 'is_ops', v_is_ops, 'is_agent_owner', v_is_agent_owner,
      'address', p_address, 'lat', p_latitude, 'lng', p_longitude, 'accuracy', p_accuracy,
      'has_smartphone', p_has_smartphone, 'ug_village_id', v_village_id
    )
  );

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'ops.user_location_updated', v_actor, 'profiles', p_user_id,
    jsonb_build_object(
      'reason', p_reason, 'lat', p_latitude, 'lng', p_longitude,
      'has_smartphone', p_has_smartphone, 'ug_village_id', v_village_id
    )
  );

  RETURN jsonb_build_object('success', true, 'user_id', p_user_id);
END;
$function$;