-- Agent vetting fixes after the screens review (2026-10-27).
--
-- 1. get_my_agent_vetting returns national_id.chosen_source. national_id.source is only set once
--    the ID check passes, so an agent waiting for their parent to approve the ID link came back
--    to the screen in "own ID" mode after a reload.
-- 2. agent_vetting.in_scope was only worked out when the row was created (the dashboard banner
--    creates one for every agent who opens it) or at submit, so an agent who became active later
--    stayed out of "Active agents only". It is now refreshed when the agent opens the screen or
--    posts a rent request, and once here for rows that are already stale.
-- CREATE OR REPLACE keeps both functions' grants.

CREATE OR REPLACE FUNCTION public.get_my_agent_vetting()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
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
    'national_id', v_id - 'front_path' - 'back_path'
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
$$;
REVOKE ALL ON FUNCTION public.get_my_agent_vetting() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_agent_vetting() TO authenticated;

CREATE OR REPLACE FUNCTION public.enforce_agent_vetting_on_rent_request()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_gate   jsonb;
BEGIN
  IF current_setting('app.bypass_agent_vetting', true) = 'true' THEN RETURN NEW; END IF;
  IF NEW.agent_id IS NULL THEN RETURN NEW; END IF;
  IF v_caller IS NOT NULL AND v_caller = NEW.tenant_id AND v_caller IS DISTINCT FROM NEW.agent_id THEN
    RETURN NEW;
  END IF;
  IF NEW.tenant_self_applied AND v_caller IS NULL THEN RETURN NEW; END IF;

  v_gate := public.agent_vetting_gate_status(NEW.agent_id);
  IF (v_gate->>'blocked')::boolean THEN
    RAISE EXCEPTION 'AGENT_NOT_VETTED: %', v_gate->>'reason' USING ERRCODE = 'check_violation';
  END IF;
  -- Posting a rent request puts the agent in scope for the Agent Ops queue. Rolls back with
  -- the insert if a later trigger refuses it.
  UPDATE public.agent_vetting SET in_scope = true, updated_at = now()
   WHERE agent_id = NEW.agent_id AND NOT in_scope;
  RETURN NEW;
END;
$$;

UPDATE public.agent_vetting v
   SET in_scope = true, updated_at = now()
 WHERE NOT v.in_scope AND public.agent_vetting_in_scope(v.agent_id);
