CREATE OR REPLACE FUNCTION public.capture_trust_signal(
  p_tenant_id uuid,
  p_signal_type text,
  p_venue_category text,
  p_venue_name text,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision DEFAULT NULL::double precision,
  p_notes text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_id uuid := auth.uid();
  v_visit_id uuid;
  v_venue_id uuid;
BEGIN
  IF v_agent_id IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;

  IF p_tenant_id IS NULL OR p_signal_type IS NULL OR p_latitude IS NULL OR p_longitude IS NULL THEN
    RAISE EXCEPTION 'missing_fields';
  END IF;

  INSERT INTO public.agent_visits (agent_id, tenant_id, latitude, longitude, accuracy, location_name, checked_in_at)
  VALUES (v_agent_id, p_tenant_id, p_latitude, p_longitude, p_accuracy, p_venue_name, now())
  RETURNING id INTO v_visit_id;

  INSERT INTO public.venue_visits
    (user_id, category, venue_name, latitude, longitude, accuracy, visited_at, source)
  VALUES
    (p_tenant_id, COALESCE(p_venue_category, 'other'), COALESCE(p_venue_name, p_signal_type),
     p_latitude, p_longitude, p_accuracy, now(), 'agent_capture')
  RETURNING id INTO v_venue_id;

  -- audit_logs has no "reason" column — fold it into metadata
  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
  VALUES (
    'trust_signal_capture',
    'venue_visits',
    v_venue_id::text,
    v_agent_id,
    jsonb_build_object(
      'reason', 'agent_field_capture',
      'signal_type', p_signal_type,
      'tenant_id', p_tenant_id,
      'venue', p_venue_name,
      'category', p_venue_category,
      'notes', p_notes
    )
  );

  PERFORM public.recompute_trust_score(p_tenant_id);

  RETURN jsonb_build_object(
    'success', true,
    'agent_visit_id', v_visit_id,
    'venue_visit_id', v_venue_id,
    'signal_type', p_signal_type
  );
END;
$function$;