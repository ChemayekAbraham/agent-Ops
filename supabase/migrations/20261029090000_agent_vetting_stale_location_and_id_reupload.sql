-- Agent vetting: two fixes from live use (2026-10-29).
--
-- 1. A captured location older than gps_rules.max_age_minutes no longer blocks submit.
--    Submit already takes a fresh reading and checks its accuracy; when the earlier
--    capture is old, that reading replaces it (gps1 = submit reading, drift 0). A fresh
--    capture is still compared with the submit reading (max_drift_m). Agents who went
--    back through the wizard, or came back the next day, kept hitting "too old".
--
-- 2. agent_vetting_request_id_reupload: Agent Ops can unlock a National ID that was
--    entered wrongly when the agent cannot replace it themselves (an identity already
--    verified for withdrawals is final, see identity_already_verified__impl). It clears
--    the ID photos on the profile, so the agent uploads the correct card through the
--    usual photo flow, which reads the number from the card. The NIN on the profile is
--    left in place until the new card replaces it. The old ID is kept for comparison
--    (prev_id_*) and the vetting goes back to the agent with the reason. Until the new
--    photos are in, the agent's identity is not verified for withdrawals.

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
  ELSIF p_lat IS NULL OR p_lng IS NULL OR p_accuracy_m IS NULL OR p_accuracy_m > s.gps_max_accuracy_m THEN
    v_missing := array_append(v_missing, 'We could not confirm your location when you submitted. Turn on location and try again.');
  ELSIF v.gps1_captured_at < now() - make_interval(mins => s.gps_max_age_minutes) THEN
    -- An old capture no longer blocks: the accurate reading taken now replaces it,
    -- so there is nothing to compare and the drift is zero.
    v_refresh := true;
    v_drift := 0;
  ELSE
    v_drift := public.agent_vetting_distance_m(v.gps1_lat, v.gps1_lng, p_lat, p_lng);
    IF v_drift > s.gps_max_drift_m THEN
      v_missing := array_append(v_missing, format('Your location moved %s m since you captured it. Capture it again where you are.', round(v_drift)));
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

CREATE OR REPLACE FUNCTION public.agent_vetting_request_id_reupload(p_agent_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v        public.agent_vetting;
  p        public.profiles;
  v_was    boolean;
BEGIN
  IF NOT public.is_agent_vetting_reviewer(v_uid) THEN
    RAISE EXCEPTION 'Only Agent Ops can ask an agent to re-upload their National ID.' USING ERRCODE = '42501';
  END IF;
  IF v_uid = p_agent_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'You cannot do this on your own verification.');
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 5 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Tell the agent what is wrong with the ID.');
  END IF;

  SELECT * INTO v FROM public.agent_vetting WHERE agent_id = p_agent_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'This agent has not started verification.');
  END IF;
  SELECT * INTO p FROM public.profiles WHERE id = p_agent_id FOR UPDATE;
  IF nullif(btrim(coalesce(p.national_id_photo_path, '')), '') IS NULL
     AND nullif(btrim(coalesce(p.national_id_back_photo_path, '')), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'There are no ID photos on file for this agent.');
  END IF;

  v_was := public.identity_already_verified__impl(p_agent_id);

  -- Record the ID on file before it changes (the reopen trigger only does this for
  -- submitted/verified rows).
  PERFORM public._agent_vetting_take_id_snapshot(p_agent_id);

  UPDATE public.profiles
     SET national_id_photo_path = NULL,
         national_id_back_photo_path = NULL,
         id_image_hash = NULL
   WHERE id = p_agent_id;

  PERFORM public._agent_vetting_take_id_snapshot(p_agent_id);

  -- Back to the agent with the reason. reviewed_at is left alone so the next submit
  -- keeps the ID recorded above as the one to compare against.
  UPDATE public.agent_vetting
     SET status = 'rejected', verified_at = NULL, review_note = v_reason, updated_at = now(),
         id_source = coalesce(id_source, v.id_source)
   WHERE agent_id = p_agent_id;

  PERFORM public._agent_vetting_log(p_agent_id, 'id_reupload_requested',
    jsonb_build_object('reason', v_reason, 'previous_status', v.status,
                       'was_identity_verified', v_was));
  RETURN jsonb_build_object('success', true, 'status', 'rejected');
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_vetting_request_id_reupload(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_vetting_request_id_reupload(uuid, text) TO authenticated, service_role;
