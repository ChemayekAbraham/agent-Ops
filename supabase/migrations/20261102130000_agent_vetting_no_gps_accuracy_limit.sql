-- Agent vetting: no GPS accuracy limit; the agent's current location is accepted.
--
-- agent_vetting_capture_gps refused readings worse than gps_max_accuracy_m (100 m), and
-- submit_agent_vetting refused them again at submit. Phones indoors or on network-only fixes
-- often report 100 m+, so agents could not get past the location step. At the user's
-- request (2026-11-02) both now take the phone's current reading as it is:
--
-- capture: only a missing / out-of-range / 0,0 reading is refused. Accuracy is still stored.
-- submit:  same validity check; a capture older than gps_max_age_minutes is still replaced by
--          the submit reading (20261029090000), and now so is one more than gps_max_drift_m
--          away, instead of "Your location moved ...". The distance stays in the event log.
-- gps_max_accuracy_m / gps_max_drift_m stay in agent_vetting_settings (get_my_agent_vetting
-- still returns them) but no longer block anything.
-- Both rebuilt from the live definitions (CREATE OR REPLACE keeps grants).

CREATE OR REPLACE FUNCTION public.agent_vetting_capture_gps(p_lat numeric, p_lng numeric, p_accuracy_m numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := public._agent_vetting_require_agent();
  s     public.agent_vetting_settings;
BEGIN
  PERFORM public._agent_vetting_ensure(v_uid);
  SELECT * INTO s FROM public.agent_vetting_settings WHERE id;
  IF p_lat IS NULL OR p_lng IS NULL OR p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180
     OR (p_lat = 0 AND p_lng = 0) THEN
    RETURN jsonb_build_object('success', false, 'message', 'We could not read your location. Turn on location and try again.');
  END IF;
  -- No accuracy limit (20261102130000): the phone's current reading is accepted as it is.
  -- The accuracy is still stored, and Agent Ops sees it in the dossier.

  UPDATE public.agent_vetting
     SET gps1_lat = p_lat, gps1_lng = p_lng, gps1_accuracy_m = p_accuracy_m, gps1_captured_at = now(),
         gps2_lat = NULL, gps2_lng = NULL, gps2_accuracy_m = NULL, gps2_captured_at = NULL, updated_at = now()
   WHERE agent_id = v_uid;
  RETURN jsonb_build_object('success', true, 'lat', p_lat, 'lng', p_lng, 'accuracy_m', p_accuracy_m, 'captured_at', now());
END;
$function$;

CREATE OR REPLACE FUNCTION public.submit_agent_vetting(p_lat numeric, p_lng numeric, p_accuracy_m numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid     uuid := public._agent_vetting_require_agent();
  v         public.agent_vetting;
  p         public.profiles;
  s         public.agent_vetting_settings;
  v_id      jsonb;
  v_missing text[] := '{}';
  v_drift   numeric;
  v_refresh boolean := false;
BEGIN
  v := public._agent_vetting_ensure(v_uid);
  -- Serialise submits for this agent (the 20-per-ID recount and status change happen together).
  SELECT * INTO v FROM public.agent_vetting WHERE agent_id = v_uid FOR UPDATE;
  SELECT * INTO p FROM public.profiles WHERE id = v_uid;
  SELECT * INTO s FROM public.agent_vetting_settings WHERE id;

  IF v.status = 'submitted' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Your details are already with Agent Ops for review.');
  END IF;
  IF v.status = 'verified' THEN
    RETURN jsonb_build_object('success', false, 'message', 'You are already verified.');
  END IF;

  IF v.phone_verified_at IS NULL OR right(regexp_replace(coalesce(v.phone, ''), '\D', '', 'g'), 9)
                                    <> right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 9) THEN
    v_missing := array_append(v_missing, 'Confirm your phone number with the code we send.');
  END IF;
  IF v.email_verified_at IS NULL OR lower(coalesce(v.email, '')) <> lower(coalesce(p.email, '')) THEN
    v_missing := array_append(v_missing, 'Confirm your email address with the code we send.');
  END IF;
  IF coalesce(btrim(p.district), '') = '' OR coalesce(btrim(p.village), '') = '' THEN
    v_missing := array_append(v_missing, 'Add where you stay (at least district and village).');
  END IF;

  IF v.gps1_captured_at IS NULL THEN
    v_missing := array_append(v_missing, 'Capture your location.');
  ELSIF p_lat IS NULL OR p_lng IS NULL OR p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180
     OR (p_lat = 0 AND p_lng = 0) THEN
    v_missing := array_append(v_missing, 'We could not confirm your location when you submitted. Turn on location and try again.');
  ELSIF v.gps1_captured_at < now() - make_interval(mins => s.gps_max_age_minutes) THEN
    -- An old capture no longer blocks: the accurate reading taken now replaces it,
    -- so there is nothing to compare and the drift is zero.
    v_refresh := true;
    v_drift := 0;
  ELSE
    v_drift := public.agent_vetting_distance_m(v.gps1_lat, v.gps1_lng, p_lat, p_lng);
    -- Moved since the capture: use the current reading instead of refusing. The distance
    -- moved stays in the 'submitted' event (gps_drift_m) for Agent Ops.
    IF v_drift > s.gps_max_drift_m THEN
      v_refresh := true;
    END IF;
  END IF;

  v_id := public._agent_vetting_id_status(v_uid, coalesce(v.id_source, 'own'));
  IF NOT (v_id->>'ok')::boolean THEN
    v_missing := array_append(v_missing, (v_id->>'reason'));
  END IF;

  IF v.passport_photo_path IS NULL THEN
    v_missing := array_append(v_missing, 'Take your passport photo.');
  END IF;
  IF coalesce(btrim(v.nok_name), '') = '' OR length(regexp_replace(coalesce(v.nok_phone, ''), '\D', '', 'g')) < 9 THEN
    v_missing := array_append(v_missing, 'Add your next of kin''s name and phone number.');
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RETURN jsonb_build_object('success', false, 'missing', to_jsonb(v_missing),
      'message', 'Some steps are not finished yet.', 'linked_to', v_id->'linked_to');
  END IF;

  -- Before reviewed_at is cleared: records the previous ID if this one replaces it.
  PERFORM public._agent_vetting_take_id_snapshot(v_uid);

  UPDATE public.agent_vetting SET
    status = 'submitted', submitted_at = now(),
    reviewed_by = NULL, reviewed_at = NULL, review_note = NULL,
    in_scope = public.agent_vetting_in_scope(v_uid),
    residence = jsonb_build_object('region', p.region, 'district', p.district, 'sub_county', p.sub_county,
                                   'parish', p.parish, 'village', p.village, 'town', p.town, 'city', p.city),
    gps2_lat = p_lat, gps2_lng = p_lng, gps2_accuracy_m = p_accuracy_m, gps2_captured_at = now(),
    gps1_lat = CASE WHEN v_refresh THEN p_lat ELSE gps1_lat END,
    gps1_lng = CASE WHEN v_refresh THEN p_lng ELSE gps1_lng END,
    gps1_accuracy_m = CASE WHEN v_refresh THEN p_accuracy_m ELSE gps1_accuracy_m END,
    gps1_captured_at = CASE WHEN v_refresh THEN now() ELSE gps1_captured_at END,
    updated_at = now()
  WHERE agent_id = v_uid;

  PERFORM public._agent_vetting_log(v_uid, 'submitted', jsonb_build_object('id_source', v_id->>'source', 'gps_drift_m', round(v_drift), 'gps_refreshed', v_refresh));
  RETURN jsonb_build_object('success', true, 'status', 'submitted');
END;
$function$;
