-- Agent vetting: National ID summary for the agent, and the previous ID kept for Agent Ops.
--
-- 1. The Identity step shows a proper summary of the ID already on file (name on the ID, masked NIN,
--    front/back photos and when they were uploaded) instead of an empty capture frame.
--    get_my_agent_vetting adds these to national_id. The photo paths are the agent's own files in
--    the identity-verification bucket (their own folder), so the screen can sign them for display.
-- 2. Agents change their ID only by uploading new photos. When an ID replaces one that was already
--    submitted, the previous one is kept (prev_id_*) so Agent Ops can compare old and new.
--    "Previous" means the ID as of the last Agent Ops decision: further changes before the next
--    review do not overwrite it.
-- 3. Fix: when a submitted or verified agent replaced their ID, the profile trigger reopened them but
--    left the old photos in the vetting record, so Agent Ops reviewed stale photos. The record is
--    now refreshed from the profile when that happens.

ALTER TABLE public.agent_vetting
  ADD COLUMN IF NOT EXISTS id_name             text,
  ADD COLUMN IF NOT EXISTS id_captured_at      timestamptz,
  ADD COLUMN IF NOT EXISTS id_changed_at       timestamptz,
  ADD COLUMN IF NOT EXISTS prev_id_source      text,
  ADD COLUMN IF NOT EXISTS prev_id_nin_masked  text,
  ADD COLUMN IF NOT EXISTS prev_id_name        text,
  ADD COLUMN IF NOT EXISTS prev_id_front_path  text,
  ADD COLUMN IF NOT EXISTS prev_id_back_path   text,
  ADD COLUMN IF NOT EXISTS prev_id_captured_at timestamptz;

-- Name as printed on the ID, from what the card reader saved on the profile.
CREATE OR REPLACE FUNCTION public._agent_vetting_name_on_id(p_uid uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT coalesce(nullif(btrim(p.national_id_name), ''),
                  nullif(btrim(concat_ws(' ', p.national_id_given_name, p.national_id_surname)), ''))
  FROM public.profiles p WHERE p.id = p_uid;
$$;
REVOKE ALL ON FUNCTION public._agent_vetting_name_on_id(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._agent_vetting_name_on_id(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public._agent_vetting_photo_uploaded_at(p_path text)
RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT o.created_at FROM storage.objects o
  WHERE o.bucket_id = 'identity-verification' AND o.name = p_path
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public._agent_vetting_photo_uploaded_at(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._agent_vetting_photo_uploaded_at(text) TO service_role;

-- The agent's own ID on file, for the summary. Never the full NIN.
CREATE OR REPLACE FUNCTION public._agent_vetting_id_details(p_uid uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'name_on_id', public._agent_vetting_name_on_id(p.id),
    'front_path', p.national_id_photo_path,
    'back_path', p.national_id_back_photo_path,
    'front_uploaded_at', public._agent_vetting_photo_uploaded_at(p.national_id_photo_path),
    'back_uploaded_at', public._agent_vetting_photo_uploaded_at(p.national_id_back_photo_path))
  FROM public.profiles p WHERE p.id = p_uid;
$$;
REVOKE ALL ON FUNCTION public._agent_vetting_id_details(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._agent_vetting_id_details(uuid) TO service_role;

-- Copies the current ID into the vetting record. If it differs from the one already recorded, and
-- that one is the ID Agent Ops last decided on (or the first submission), it is kept as prev_id_*.
CREATE OR REPLACE FUNCTION public._agent_vetting_take_id_snapshot(p_uid uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v        public.agent_vetting;
  v_id     jsonb;
  v_name   text;
  v_at     timestamptz;
  v_change boolean;
BEGIN
  SELECT * INTO v FROM public.agent_vetting WHERE agent_id = p_uid FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  v_id := public._agent_vetting_id_status(p_uid, coalesce(v.id_source, 'own'));
  IF v_id->>'source' = 'parent' THEN
    v_name := public._agent_vetting_name_on_id((v_id->>'holder_id')::uuid);
  ELSE
    v_name := public._agent_vetting_name_on_id(p_uid);
    v_at   := public._agent_vetting_photo_uploaded_at(v_id->>'front_path');
  END IF;

  v_change := (v.id_front_path IS NOT NULL OR v.id_nin_masked IS NOT NULL)
    AND row(v.id_source, v.id_nin_masked, v.id_front_path, v.id_back_path)
        IS DISTINCT FROM row(v_id->>'source', v_id->>'nin_masked', v_id->>'front_path', v_id->>'back_path');

  UPDATE public.agent_vetting SET
    prev_id_source      = CASE WHEN v_change AND (v.id_changed_at IS NULL OR v.id_changed_at <= coalesce(v.reviewed_at, '-infinity'::timestamptz))
                               THEN v.id_source ELSE prev_id_source END,
    prev_id_nin_masked  = CASE WHEN v_change AND (v.id_changed_at IS NULL OR v.id_changed_at <= coalesce(v.reviewed_at, '-infinity'::timestamptz))
                               THEN v.id_nin_masked ELSE prev_id_nin_masked END,
    prev_id_name        = CASE WHEN v_change AND (v.id_changed_at IS NULL OR v.id_changed_at <= coalesce(v.reviewed_at, '-infinity'::timestamptz))
                               THEN v.id_name ELSE prev_id_name END,
    prev_id_front_path  = CASE WHEN v_change AND (v.id_changed_at IS NULL OR v.id_changed_at <= coalesce(v.reviewed_at, '-infinity'::timestamptz))
                               THEN v.id_front_path ELSE prev_id_front_path END,
    prev_id_back_path   = CASE WHEN v_change AND (v.id_changed_at IS NULL OR v.id_changed_at <= coalesce(v.reviewed_at, '-infinity'::timestamptz))
                               THEN v.id_back_path ELSE prev_id_back_path END,
    prev_id_captured_at = CASE WHEN v_change AND (v.id_changed_at IS NULL OR v.id_changed_at <= coalesce(v.reviewed_at, '-infinity'::timestamptz))
                               THEN v.id_captured_at ELSE prev_id_captured_at END,
    id_changed_at       = CASE WHEN v_change THEN now() ELSE id_changed_at END,
    id_source           = v_id->>'source',
    id_nin_masked       = v_id->>'nin_masked',
    id_front_path       = v_id->>'front_path',
    id_back_path        = v_id->>'back_path',
    id_holder_id        = (v_id->>'holder_id')::uuid,
    id_link_request_id  = (v_id->>'link_request_id')::uuid,
    id_name             = v_name,
    id_captured_at      = v_at,
    updated_at          = now()
  WHERE agent_id = p_uid;

  IF v_change THEN
    PERFORM public._agent_vetting_log(p_uid, 'id_replaced',
      jsonb_build_object('previous_nin_masked', v.id_nin_masked, 'new_nin_masked', v_id->>'nin_masked',
                         'previous_source', v.id_source, 'new_source', v_id->>'source'));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._agent_vetting_take_id_snapshot(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._agent_vetting_take_id_snapshot(uuid) TO service_role;

-- Profile ID change: record the new ID for anyone already submitted or verified (before reopening,
-- while reviewed_at still says what Agent Ops last decided), then send verified agents back to review.
CREATE OR REPLACE FUNCTION public.agent_vetting_reopen_on_id_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.agent_vetting WHERE agent_id = NEW.id AND status IN ('submitted', 'verified')) THEN
    PERFORM public._agent_vetting_take_id_snapshot(NEW.id);
  END IF;
  PERFORM public._agent_vetting_reopen(NEW.id, 'national_id');
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.agent_vetting_reopen_on_id_change() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_my_agent_vetting()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid := public._agent_vetting_require_agent();
  v        public.agent_vetting;
  p        public.profiles;
  s        public.agent_vetting_settings;
  v_id     jsonb;
  v_parent uuid;
  v_pp     public.profiles;
BEGIN
  v := public._agent_vetting_ensure(v_uid);
  -- in_scope is set when the row is created; an agent who becomes active later is caught here.
  IF NOT v.in_scope AND public.agent_vetting_in_scope(v_uid) THEN
    UPDATE public.agent_vetting SET in_scope = true, updated_at = now() WHERE agent_id = v_uid;
    v.in_scope := true;
  END IF;
  SELECT * INTO p FROM public.profiles WHERE id = v_uid;
  SELECT * INTO s FROM public.agent_vetting_settings WHERE id;
  v_id := public._agent_vetting_id_status(v_uid, coalesce(v.id_source, CASE WHEN p.linked_national_id IS NOT NULL THEN 'parent' ELSE 'own' END));
  v_parent := public._agent_vetting_parent(v_uid);
  SELECT * INTO v_pp FROM public.profiles WHERE id = v_parent;

  RETURN jsonb_build_object(
    'status', v.status,
    'review_note', v.review_note,
    'submitted_at', v.submitted_at,
    'verified_at', v.verified_at,
    'enforced', coalesce(s.enforce, false) AND (s.enforce_from IS NULL OR s.enforce_from <= now()),
    'enforce_from', s.enforce_from,
    'phone', jsonb_build_object('value', p.phone, 'verified_at', v.phone_verified_at),
    'email', jsonb_build_object('value', CASE WHEN public.agent_vetting_is_real_email(p.email) THEN p.email END,
                                'verified_at', v.email_verified_at),
    'residence', jsonb_build_object('region', p.region, 'district', p.district, 'sub_county', p.sub_county,
                                    'parish', p.parish, 'village', p.village, 'town', p.town, 'city', p.city,
                                    'complete', coalesce(p.address_complete, false)),
    'gps', jsonb_build_object('lat', v.gps1_lat, 'lng', v.gps1_lng, 'accuracy_m', v.gps1_accuracy_m,
                              'captured_at', v.gps1_captured_at),
    'national_id', v_id - 'front_path' - 'back_path' || public._agent_vetting_id_details(v_uid)
                   || jsonb_build_object('has_front', p.national_id_photo_path IS NOT NULL,
                                         'has_back', p.national_id_back_photo_path IS NOT NULL,
                                         'can_use_parent', v_parent IS NOT NULL,
                                         -- What the agent chose, even while that choice isn't finished
                                         -- (e.g. waiting for the parent to approve). 'source' is only
                                         -- set once the ID check passes.
                                         'chosen_source', v.id_source),
    'passport_photo', jsonb_build_object('path', v.passport_photo_path, 'check', v.passport_photo_check),
    'next_of_kin', jsonb_build_object('name', v.nok_name, 'phone', v.nok_phone, 'relationship', v.nok_relationship,
                                      'source', v.nok_source),
    'parent_agent', CASE WHEN v_pp.id IS NOT NULL
                      THEN jsonb_build_object('id', v_pp.id, 'name', v_pp.full_name, 'phone', v_pp.phone) END,
    'gps_rules', jsonb_build_object('max_accuracy_m', s.gps_max_accuracy_m, 'max_drift_m', s.gps_max_drift_m,
                                    'max_age_minutes', s.gps_max_age_minutes));
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
  ELSIF v.gps1_captured_at < now() - make_interval(mins => s.gps_max_age_minutes) THEN
    v_missing := array_append(v_missing, 'Your captured location is too old. Capture it again.');
  ELSIF p_lat IS NULL OR p_lng IS NULL OR p_accuracy_m IS NULL OR p_accuracy_m > s.gps_max_accuracy_m THEN
    v_missing := array_append(v_missing, 'We could not confirm your location when you submitted. Turn on location and try again.');
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
    updated_at = now()
  WHERE agent_id = v_uid;

  PERFORM public._agent_vetting_log(v_uid, 'submitted', jsonb_build_object('id_source', v_id->>'source', 'gps_drift_m', round(v_drift)));
  RETURN jsonb_build_object('success', true, 'status', 'submitted');
END;
$function$;

-- Name and upload date for records submitted before this migration (no previous ID to infer).
UPDATE public.agent_vetting v
   SET id_name = CASE WHEN v.id_source = 'parent' THEN public._agent_vetting_name_on_id(v.id_holder_id)
                      ELSE public._agent_vetting_name_on_id(v.agent_id) END,
       id_captured_at = public._agent_vetting_photo_uploaded_at(v.id_front_path)
 WHERE v.status <> 'unverified' AND v.id_name IS NULL;
