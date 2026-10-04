
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS has_smartphone boolean NOT NULL DEFAULT true;

-- Replace ops_update_user_location with extended signature (adds p_has_smartphone)
CREATE OR REPLACE FUNCTION public.ops_update_user_location(
  p_user_id        uuid,
  p_address        jsonb,
  p_latitude       double precision,
  p_longitude      double precision,
  p_accuracy       double precision,
  p_reason         text,
  p_has_smartphone boolean DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_is_ops boolean;
  v_is_agent_owner boolean;
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
      'has_smartphone', p_has_smartphone
    )
  );

  INSERT INTO public.system_events (event_type, actor_id, subject_id, payload)
  VALUES (
    'ops.user_location_updated', v_actor, p_user_id,
    jsonb_build_object('reason', p_reason, 'lat', p_latitude, 'lng', p_longitude, 'has_smartphone', p_has_smartphone)
  );

  RETURN jsonb_build_object('success', true, 'user_id', p_user_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.ops_update_user_location(uuid, jsonb, double precision, double precision, double precision, text, boolean) TO authenticated;

-- Landlord smartphone toggle
CREATE OR REPLACE FUNCTION public.ops_update_landlord_smartphone(
  p_landlord_id   uuid,
  p_has_smartphone boolean,
  p_reason        text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.is_ops_role(v_actor) THEN
    RAISE EXCEPTION 'Only ops roles can edit landlord profile';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  UPDATE public.landlords SET has_smartphone = p_has_smartphone WHERE id = p_landlord_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_actor, 'ops.update_landlord_smartphone', 'landlords', p_landlord_id::text,
    jsonb_build_object('has_smartphone', p_has_smartphone, 'reason', p_reason)
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.ops_update_landlord_smartphone(uuid, boolean, text) TO authenticated;
