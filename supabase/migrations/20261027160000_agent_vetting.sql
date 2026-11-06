-- Agent vetting: Agent Ops verifies every active agent before they can add tenants or post
-- Rent Plan requests.
--
-- WHAT AN AGENT SUBMITS (decided with Pius, 2026-10-23 / 2026-10-27)
--   phone      : the phone on their profile, confirmed by SMS code (sms-otp, otp_verifications)
--   email      : a real address confirmed by email code (email-verify-request/-confirm).
--                54k agent emails are synthetic (@welile.agent, @welile.user), so "on file" proves nothing.
--   residence  : where they stay. Pre-filled from profiles; edits are written back to profiles.
--   live GPS   : captured by a button, shown read-only, captured again on submit. The two readings
--                must be accurate and close together; we cannot prove a browser location, only that
--                it was steady and recent.
--   National ID: front and back on profiles (existing identity flows), either their own NIN or,
--                with no ID, their parent agent's NIN through the existing link-consent flow
--                (request_national_id_link, 20 accounts per ID).
--   passport photo: a selfie in the identity-verification bucket, graded by verify-passport-photo.
--   next of kin: defaults to the parent agent (copied, not linked); the agent may replace it.
--
-- WHO IS IN SCOPE
--   59.5k users hold the agent role but ~115 post in a month, so the role alone can't define the
--   queue. In scope = posted a rent request as agent, has collections, or is a parent agent.
--   Anyone else is checked only when they try to post (the rent_requests gate below).
--
-- ROLLOUT
--   Ships with the gate OFF. Agents see their checklist and Agent Ops can review, but nothing is
--   blocked until
--     UPDATE public.agent_vetting_settings SET enforce = true;
--   (optionally with enforce_from for a dated switch). Flipping it back needs no deploy.
--
-- Status is agent_vetting.status. Not to be confused with rent_requests.agent_verified (a
-- request-level check) or service_center_vetting_* (service-centre requests).

-- ---------------------------------------------------------------------------------------
-- 1. Settings (one row)
-- ---------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agent_vetting_settings (
  id                   boolean PRIMARY KEY DEFAULT true CHECK (id),
  enforce              boolean NOT NULL DEFAULT false,
  enforce_from         timestamptz,
  gps_max_accuracy_m   numeric NOT NULL DEFAULT 100 CHECK (gps_max_accuracy_m > 0),
  gps_max_drift_m      numeric NOT NULL DEFAULT 200 CHECK (gps_max_drift_m > 0),
  gps_max_age_minutes  integer NOT NULL DEFAULT 10  CHECK (gps_max_age_minutes > 0),
  otp_max_age_minutes  integer NOT NULL DEFAULT 30  CHECK (otp_max_age_minutes > 0),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.agent_vetting_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.agent_vetting_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_vetting_settings_read ON public.agent_vetting_settings;
CREATE POLICY agent_vetting_settings_read ON public.agent_vetting_settings
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS mfa_required_for_staff ON public.agent_vetting_settings;
CREATE POLICY mfa_required_for_staff ON public.agent_vetting_settings AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));
REVOKE ALL ON public.agent_vetting_settings FROM anon, authenticated;
GRANT SELECT ON public.agent_vetting_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_vetting_settings TO service_role;

-- ---------------------------------------------------------------------------------------
-- 2. One row per agent
-- ---------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agent_vetting (
  agent_id             uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  status               text NOT NULL DEFAULT 'unverified'
                         CHECK (status IN ('unverified', 'submitted', 'verified', 'rejected')),
  in_scope             boolean NOT NULL DEFAULT false,

  phone                text,
  phone_verified_at    timestamptz,
  email                text,
  email_verified_at    timestamptz,

  residence            jsonb,          -- copy of the profile address at submit

  gps1_lat             numeric, gps1_lng numeric, gps1_accuracy_m numeric, gps1_captured_at timestamptz,
  gps2_lat             numeric, gps2_lng numeric, gps2_accuracy_m numeric, gps2_captured_at timestamptz,

  id_source            text CHECK (id_source IN ('own', 'parent')),
  id_nin_masked        text,
  id_front_path        text,
  id_back_path         text,
  id_holder_id         uuid REFERENCES public.profiles(id),
  id_link_request_id   uuid,

  passport_photo_path  text,
  passport_photo_check jsonb,

  nok_name             text,
  nok_phone            text,
  nok_relationship     text,
  nok_source           text CHECK (nok_source IN ('parent_agent', 'custom')),
  nok_agent_id         uuid REFERENCES public.profiles(id),

  submitted_at         timestamptz,
  reviewed_by          uuid REFERENCES public.profiles(id),
  reviewed_at          timestamptz,
  review_note          text,
  verified_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_vetting_status_idx ON public.agent_vetting (status, submitted_at);

CREATE TABLE IF NOT EXISTS public.agent_vetting_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  event       text NOT NULL,
  actor_id    uuid,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_vetting_events_agent_idx ON public.agent_vetting_events (agent_id, created_at DESC);

-- Reviewers: Agent Ops, plus the executives who oversee it.
CREATE OR REPLACE FUNCTION public.is_agent_vetting_reviewer(p_uid uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT p_uid IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_uid AND role IN ('agent_ops', 'super_admin', 'cto', 'coo'));
$$;
REVOKE ALL ON FUNCTION public.is_agent_vetting_reviewer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_agent_vetting_reviewer(uuid) TO authenticated, service_role;

-- Reads go through the RPCs below; the table policies are the second lock. No direct writes.
ALTER TABLE public.agent_vetting ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_vetting_read ON public.agent_vetting;
CREATE POLICY agent_vetting_read ON public.agent_vetting FOR SELECT TO authenticated
  USING (agent_id = (SELECT auth.uid()) OR (SELECT public.is_agent_vetting_reviewer(auth.uid())));
DROP POLICY IF EXISTS mfa_required_for_staff ON public.agent_vetting;
CREATE POLICY mfa_required_for_staff ON public.agent_vetting AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));
REVOKE ALL ON public.agent_vetting FROM anon, authenticated;
GRANT SELECT ON public.agent_vetting TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_vetting TO service_role;

ALTER TABLE public.agent_vetting_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_vetting_events_read ON public.agent_vetting_events;
CREATE POLICY agent_vetting_events_read ON public.agent_vetting_events FOR SELECT TO authenticated
  USING (agent_id = (SELECT auth.uid()) OR (SELECT public.is_agent_vetting_reviewer(auth.uid())));
DROP POLICY IF EXISTS mfa_required_for_staff ON public.agent_vetting_events;
CREATE POLICY mfa_required_for_staff ON public.agent_vetting_events AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));
REVOKE ALL ON public.agent_vetting_events FROM anon, authenticated;
GRANT SELECT ON public.agent_vetting_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_vetting_events TO service_role;

-- Agent Ops reads the submitted photos (own-folder and finance policies already exist).
DROP POLICY IF EXISTS "identity agent vetting reviewer select" ON storage.objects;
CREATE POLICY "identity agent vetting reviewer select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'identity-verification'
         AND public.is_agent_vetting_reviewer(auth.uid())
         AND EXISTS (SELECT 1 FROM public.agent_vetting v
                     WHERE v.agent_id::text = (storage.foldername(name))[1]
                       AND v.status <> 'unverified'));

-- ---------------------------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_vetting_in_scope(p_uid uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT p_uid IS NOT NULL AND (
       EXISTS (SELECT 1 FROM public.rent_requests r WHERE r.agent_id = p_uid)
    OR EXISTS (SELECT 1 FROM public.agent_collections c WHERE c.agent_id = p_uid)
    OR EXISTS (SELECT 1 FROM public.agent_subagents s WHERE s.parent_agent_id = p_uid AND s.status = 'verified'));
$$;
REVOKE ALL ON FUNCTION public.agent_vetting_in_scope(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_vetting_in_scope(uuid) TO service_role;

-- Synthetic sign-up addresses are not an email on file.
CREATE OR REPLACE FUNCTION public.agent_vetting_is_real_email(p_email text)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $$
  SELECT coalesce(p_email, '') ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     AND lower(split_part(p_email, '@', 2)) NOT LIKE '%welile.agent'
     AND lower(split_part(p_email, '@', 2)) NOT LIKE '%welile.user';
$$;
GRANT EXECUTE ON FUNCTION public.agent_vetting_is_real_email(text) TO authenticated, service_role;

-- Great-circle distance in metres.
CREATE OR REPLACE FUNCTION public.agent_vetting_distance_m(p_lat1 numeric, p_lng1 numeric, p_lat2 numeric, p_lng2 numeric)
RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $$
  SELECT (2 * 6371000 * asin(sqrt(
      power(sin(radians((p_lat2 - p_lat1)::float8) / 2), 2)
    + cos(radians(p_lat1::float8)) * cos(radians(p_lat2::float8))
      * power(sin(radians((p_lng2 - p_lng1)::float8) / 2), 2))))::numeric;
$$;
GRANT EXECUTE ON FUNCTION public.agent_vetting_distance_m(numeric, numeric, numeric, numeric) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._agent_vetting_parent(p_uid uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT s.parent_agent_id FROM public.agent_subagents s
  WHERE s.sub_agent_id = p_uid AND s.status = 'verified'
  ORDER BY s.verified_at DESC NULLS LAST, s.created_at DESC
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public._agent_vetting_parent(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._agent_vetting_parent(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public._agent_vetting_log(p_agent uuid, p_event text, p_detail jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  INSERT INTO public.agent_vetting_events (agent_id, event, actor_id, detail)
  VALUES (p_agent, p_event, auth.uid(), coalesce(p_detail, '{}'::jsonb));
$$;
REVOKE ALL ON FUNCTION public._agent_vetting_log(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._agent_vetting_log(uuid, text, jsonb) TO service_role;

-- Creates the row on first touch, with next of kin defaulted to the parent agent.
CREATE OR REPLACE FUNCTION public._agent_vetting_ensure(p_uid uuid)
RETURNS public.agent_vetting
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_row    public.agent_vetting;
  v_parent uuid;
BEGIN
  SELECT * INTO v_row FROM public.agent_vetting WHERE agent_id = p_uid;
  IF FOUND THEN RETURN v_row; END IF;

  v_parent := public._agent_vetting_parent(p_uid);
  INSERT INTO public.agent_vetting (agent_id, in_scope, nok_name, nok_phone, nok_relationship, nok_source, nok_agent_id)
  SELECT p_uid, public.agent_vetting_in_scope(p_uid),
         pp.full_name, pp.phone,
         CASE WHEN pp.id IS NOT NULL THEN 'Parent agent' END,
         CASE WHEN pp.id IS NOT NULL THEN 'parent_agent' END,
         pp.id
  FROM (SELECT 1) one
  LEFT JOIN public.profiles pp ON pp.id = v_parent
  ON CONFLICT (agent_id) DO NOTHING;

  SELECT * INTO v_row FROM public.agent_vetting WHERE agent_id = p_uid;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public._agent_vetting_ensure(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._agent_vetting_ensure(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public._agent_vetting_require_agent()
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Please sign in again.' USING ERRCODE = '28000';
  END IF;
  IF NOT public.has_role(v_uid, 'agent'::app_role) THEN
    RAISE EXCEPTION 'Agent verification is only for agents.' USING ERRCODE = '42501';
  END IF;
  RETURN v_uid;
END;
$$;
REVOKE ALL ON FUNCTION public._agent_vetting_require_agent() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._agent_vetting_require_agent() TO service_role;

-- Verified agents who change what was verified go back to Agent Ops.
CREATE OR REPLACE FUNCTION public._agent_vetting_reopen(p_uid uuid, p_what text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.agent_vetting
     SET status = 'submitted', submitted_at = now(), verified_at = NULL,
         reviewed_by = NULL, reviewed_at = NULL, updated_at = now()
   WHERE agent_id = p_uid AND status = 'verified';
  IF FOUND THEN
    PERFORM public._agent_vetting_log(p_uid, 'reopened', jsonb_build_object('changed', p_what));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._agent_vetting_reopen(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._agent_vetting_reopen(uuid, text) TO service_role;

-- The ID check, shared by the checklist and submit. Never returns the full NIN.
CREATE OR REPLACE FUNCTION public._agent_vetting_id_status(p_uid uuid, p_source text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  p        public.profiles;
  v_parent uuid := public._agent_vetting_parent(p_uid);
  v_holder uuid;
  v_link   public.national_id_link_requests;
  v_count  int;
  v_hname  text;
BEGIN
  SELECT * INTO p FROM public.profiles WHERE id = p_uid;

  IF p_source = 'parent' THEN
    IF v_parent IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'You have no parent agent, so you need your own National ID.');
    END IF;
    SELECT * INTO v_link FROM public.national_id_link_requests
     WHERE requester_id = p_uid AND holder_id = v_parent AND status = 'active'
     ORDER BY updated_at DESC LIMIT 1;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason',
        'Ask to be linked to your parent agent''s National ID. They must confirm the code and approve it in the app.');
    END IF;
    -- request_national_id_link counts at request time only; recount here.
    SELECT 1 + count(*) INTO v_count FROM public.national_id_link_requests
     WHERE nin_fuzzy = v_link.nin_fuzzy AND status = 'active';
    IF v_count > 20 THEN
      RETURN jsonb_build_object('ok', false, 'reason',
        'Your parent agent''s National ID is already used by 20 accounts. Please use your own National ID.');
    END IF;
    RETURN jsonb_build_object('ok', true, 'source', 'parent', 'nin_masked', public.mask_national_id(v_link.nin),
      'holder_id', v_parent, 'link_request_id', v_link.id, 'accounts_on_id', v_count);
  END IF;

  IF coalesce(p.national_id, '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Add your National ID number.');
  END IF;
  IF p.national_id_photo_path IS NULL OR p.national_id_back_photo_path IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Take photos of the front and back of your National ID.',
      'nin_masked', public.mask_national_id(p.national_id));
  END IF;
  v_holder := public.duplicate_national_id_owner(p_uid, p.national_id);
  IF v_holder IS NOT NULL THEN
    SELECT split_part(btrim(coalesce(nullif(h.national_id_given_name, ''), h.full_name, '')), ' ', 1)
      INTO v_hname FROM public.profiles h WHERE h.id = v_holder;
    RETURN jsonb_build_object('ok', false, 'reason', 'This National ID is already linked to another account.',
      'nin_masked', public.mask_national_id(p.national_id),
      'linked_to', jsonb_build_object('first_name', nullif(initcap(lower(v_hname)), ''),
                                      'phone_masked', (SELECT '****' || right(h.phone, 3) FROM public.profiles h WHERE h.id = v_holder)));
  END IF;
  RETURN jsonb_build_object('ok', true, 'source', 'own', 'nin_masked', public.mask_national_id(p.national_id),
    'front_path', p.national_id_photo_path, 'back_path', p.national_id_back_photo_path);
END;
$$;
REVOKE ALL ON FUNCTION public._agent_vetting_id_status(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._agent_vetting_id_status(uuid, text) TO service_role;

-- ---------------------------------------------------------------------------------------
-- 4. Agent RPCs
-- ---------------------------------------------------------------------------------------

-- Everything the vetting screen needs, pre-filled, with a step-by-step checklist.
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
                                         'can_use_parent', v_parent IS NOT NULL),
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

-- Call after sms-otp `verify` succeeds for the profile phone. The code proves the phone; this
-- only stamps it. A different number must go through the phone-change flow first.
CREATE OR REPLACE FUNCTION public.agent_vetting_confirm_phone()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_uid   uuid := public._agent_vetting_require_agent();
  v_phone text;
  v_mins  int;
  v_at    timestamptz;
BEGIN
  PERFORM public._agent_vetting_ensure(v_uid);
  SELECT phone INTO v_phone FROM public.profiles WHERE id = v_uid;
  SELECT otp_max_age_minutes INTO v_mins FROM public.agent_vetting_settings WHERE id;
  IF length(regexp_replace(coalesce(v_phone, ''), '\D', '', 'g')) < 9 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Add a phone number to your profile first.');
  END IF;

  SELECT o.verified_at INTO v_at FROM public.otp_verifications o
   WHERE o.phone = right(regexp_replace(v_phone, '\D', '', 'g'), 9)
     AND o.verified AND o.verified_at >= now() - make_interval(mins => v_mins);
  IF v_at IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Enter the code we sent to your phone first.');
  END IF;

  UPDATE public.agent_vetting SET phone = v_phone, phone_verified_at = v_at, updated_at = now() WHERE agent_id = v_uid;
  PERFORM public._agent_vetting_log(v_uid, 'phone_confirmed', '{}'::jsonb);
  RETURN jsonb_build_object('success', true, 'verified_at', v_at);
END;
$$;
REVOKE ALL ON FUNCTION public.agent_vetting_confirm_phone() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_vetting_confirm_phone() TO authenticated;

-- Call after email-verify-confirm succeeds; that flow has already written profiles.email.
CREATE OR REPLACE FUNCTION public.agent_vetting_confirm_email()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_uid   uuid := public._agent_vetting_require_agent();
  v_email text;
  v_mins  int;
  v_at    timestamptz;
BEGIN
  PERFORM public._agent_vetting_ensure(v_uid);
  SELECT email INTO v_email FROM public.profiles WHERE id = v_uid;
  SELECT otp_max_age_minutes INTO v_mins FROM public.agent_vetting_settings WHERE id;
  IF NOT public.agent_vetting_is_real_email(v_email) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Add your own email address and confirm it with the code we send.');
  END IF;

  SELECT max(c.verified_at) INTO v_at FROM public.email_verification_challenges c
   WHERE c.user_id = v_uid AND lower(c.new_email) = lower(v_email)
     AND c.verified_at >= now() - make_interval(mins => v_mins);
  IF v_at IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Enter the code we emailed you first.');
  END IF;

  UPDATE public.agent_vetting SET email = v_email, email_verified_at = v_at, updated_at = now() WHERE agent_id = v_uid;
  PERFORM public._agent_vetting_log(v_uid, 'email_confirmed', '{}'::jsonb);
  RETURN jsonb_build_object('success', true, 'verified_at', v_at);
END;
$$;
REVOKE ALL ON FUNCTION public.agent_vetting_confirm_email() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_vetting_confirm_email() TO authenticated;

-- Residence (where the agent stays). Written to the profile so every surface sees the same address.
CREATE OR REPLACE FUNCTION public.agent_vetting_save_residence(
  p_region text, p_district text, p_sub_county text, p_parish text, p_village text,
  p_town text DEFAULT NULL, p_city text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := public._agent_vetting_require_agent();
  p     public.profiles;
BEGIN
  PERFORM public._agent_vetting_ensure(v_uid);
  IF coalesce(btrim(p_district), '') = '' OR coalesce(btrim(p_village), '') = '' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Enter at least your district and village.');
  END IF;
  SELECT * INTO p FROM public.profiles WHERE id = v_uid;

  UPDATE public.profiles
     SET region = nullif(btrim(p_region), ''), district = btrim(p_district),
         sub_county = nullif(btrim(p_sub_county), ''), parish = nullif(btrim(p_parish), ''),
         village = btrim(p_village), town = nullif(btrim(p_town), ''), city = nullif(btrim(p_city), ''),
         residence_updated_at = now()
   WHERE id = v_uid;

  IF row(p.region, p.district, p.sub_county, p.parish, p.village, p.town, p.city) IS DISTINCT FROM
     row(nullif(btrim(p_region), ''), btrim(p_district), nullif(btrim(p_sub_county), ''), nullif(btrim(p_parish), ''),
         btrim(p_village), nullif(btrim(p_town), ''), nullif(btrim(p_city), '')) THEN
    PERFORM public._agent_vetting_log(v_uid, 'residence_saved', '{}'::jsonb);
    PERFORM public._agent_vetting_reopen(v_uid, 'residence');
  END IF;
  RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.agent_vetting_save_residence(text, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_vetting_save_residence(text, text, text, text, text, text, text) TO authenticated;

-- First live-location reading, from the "Capture my location" button.
CREATE OR REPLACE FUNCTION public.agent_vetting_capture_gps(p_lat numeric, p_lng numeric, p_accuracy_m numeric)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
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
  IF p_accuracy_m IS NULL OR p_accuracy_m > s.gps_max_accuracy_m THEN
    RETURN jsonb_build_object('success', false, 'message',
      format('Your location is not accurate enough (needs %s m or better). Move outside or near a window and try again.', s.gps_max_accuracy_m));
  END IF;

  UPDATE public.agent_vetting
     SET gps1_lat = p_lat, gps1_lng = p_lng, gps1_accuracy_m = p_accuracy_m, gps1_captured_at = now(),
         gps2_lat = NULL, gps2_lng = NULL, gps2_accuracy_m = NULL, gps2_captured_at = NULL, updated_at = now()
   WHERE agent_id = v_uid;
  RETURN jsonb_build_object('success', true, 'lat', p_lat, 'lng', p_lng, 'accuracy_m', p_accuracy_m, 'captured_at', now());
END;
$$;
REVOKE ALL ON FUNCTION public.agent_vetting_capture_gps(numeric, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_vetting_capture_gps(numeric, numeric, numeric) TO authenticated;

-- Draft save for the ID source, passport photo and next of kin. NULL leaves a field as it is.
CREATE OR REPLACE FUNCTION public.agent_vetting_save_details(
  p_id_source text DEFAULT NULL,
  p_passport_photo_path text DEFAULT NULL,
  p_passport_photo_check jsonb DEFAULT NULL,
  p_nok_name text DEFAULT NULL,
  p_nok_phone text DEFAULT NULL,
  p_nok_relationship text DEFAULT NULL,
  p_nok_use_parent boolean DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_uid    uuid := public._agent_vetting_require_agent();
  v        public.agent_vetting;
  v_parent uuid;
  v_pp     public.profiles;
BEGIN
  v := public._agent_vetting_ensure(v_uid);

  IF p_id_source IS NOT NULL AND p_id_source NOT IN ('own', 'parent') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Choose your own National ID or your parent agent''s.');
  END IF;
  IF p_passport_photo_path IS NOT NULL THEN
    IF split_part(p_passport_photo_path, '/', 1) <> v_uid::text THEN
      RETURN jsonb_build_object('success', false, 'message', 'That photo does not belong to your account.');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'identity-verification' AND o.name = p_passport_photo_path) THEN
      RETURN jsonb_build_object('success', false, 'message', 'Upload your passport photo again.');
    END IF;
  END IF;

  IF p_nok_use_parent THEN
    v_parent := public._agent_vetting_parent(v_uid);
    SELECT * INTO v_pp FROM public.profiles WHERE id = v_parent;
    IF v_pp.id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'message', 'You have no parent agent. Enter your next of kin.');
    END IF;
  END IF;

  UPDATE public.agent_vetting SET
    id_source            = coalesce(p_id_source, id_source),
    passport_photo_path  = coalesce(p_passport_photo_path, passport_photo_path),
    passport_photo_check = CASE WHEN p_passport_photo_path IS NOT NULL THEN p_passport_photo_check ELSE passport_photo_check END,
    nok_name             = CASE WHEN p_nok_use_parent THEN v_pp.full_name    ELSE coalesce(nullif(btrim(p_nok_name), ''), nok_name) END,
    nok_phone            = CASE WHEN p_nok_use_parent THEN v_pp.phone        ELSE coalesce(nullif(btrim(p_nok_phone), ''), nok_phone) END,
    nok_relationship     = CASE WHEN p_nok_use_parent THEN 'Parent agent'    ELSE coalesce(nullif(btrim(p_nok_relationship), ''), nok_relationship) END,
    nok_source           = CASE WHEN p_nok_use_parent THEN 'parent_agent'
                                WHEN p_nok_name IS NOT NULL OR p_nok_phone IS NOT NULL THEN 'custom'
                                ELSE nok_source END,
    nok_agent_id         = CASE WHEN p_nok_use_parent THEN v_pp.id
                                WHEN p_nok_name IS NOT NULL OR p_nok_phone IS NOT NULL THEN NULL
                                ELSE nok_agent_id END,
    updated_at           = now()
  WHERE agent_id = v_uid;

  IF p_id_source IS NOT NULL AND p_id_source IS DISTINCT FROM v.id_source THEN
    PERFORM public._agent_vetting_reopen(v_uid, 'national_id_source');
  END IF;
  IF p_passport_photo_path IS NOT NULL AND p_passport_photo_path IS DISTINCT FROM v.passport_photo_path THEN
    PERFORM public._agent_vetting_reopen(v_uid, 'passport_photo');
  END IF;
  PERFORM public._agent_vetting_log(v_uid, 'details_saved', jsonb_strip_nulls(jsonb_build_object(
    'id_source', p_id_source, 'passport_photo', p_passport_photo_path IS NOT NULL,
    'next_of_kin', CASE WHEN p_nok_use_parent THEN 'parent_agent'
                        WHEN p_nok_name IS NOT NULL OR p_nok_phone IS NOT NULL THEN 'custom' END)));
  RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.agent_vetting_save_details(text, text, jsonb, text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_vetting_save_details(text, text, jsonb, text, text, text, boolean) TO authenticated;

-- Submit for Agent Ops review. The second GPS reading is taken by the screen at the moment of
-- submit. Returns every missing step at once so the agent can fix them in one pass.
CREATE OR REPLACE FUNCTION public.submit_agent_vetting(p_lat numeric, p_lng numeric, p_accuracy_m numeric)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
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

  UPDATE public.agent_vetting SET
    status = 'submitted', submitted_at = now(),
    reviewed_by = NULL, reviewed_at = NULL, review_note = NULL,
    in_scope = public.agent_vetting_in_scope(v_uid),
    residence = jsonb_build_object('region', p.region, 'district', p.district, 'sub_county', p.sub_county,
                                   'parish', p.parish, 'village', p.village, 'town', p.town, 'city', p.city),
    gps2_lat = p_lat, gps2_lng = p_lng, gps2_accuracy_m = p_accuracy_m, gps2_captured_at = now(),
    id_source = v_id->>'source', id_nin_masked = v_id->>'nin_masked',
    id_front_path = v_id->>'front_path', id_back_path = v_id->>'back_path',
    id_holder_id = (v_id->>'holder_id')::uuid, id_link_request_id = (v_id->>'link_request_id')::uuid,
    updated_at = now()
  WHERE agent_id = v_uid;

  PERFORM public._agent_vetting_log(v_uid, 'submitted', jsonb_build_object('id_source', v_id->>'source', 'gps_drift_m', round(v_drift)));
  RETURN jsonb_build_object('success', true, 'status', 'submitted');
END;
$$;
REVOKE ALL ON FUNCTION public.submit_agent_vetting(numeric, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_agent_vetting(numeric, numeric, numeric) TO authenticated;

-- ---------------------------------------------------------------------------------------
-- 5. Agent Ops RPCs
-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_vetting_queue(
  p_status text DEFAULT 'submitted', p_search text DEFAULT NULL,
  p_in_scope_only boolean DEFAULT false, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_rows  jsonb;
  v_total int;
  v_q     text := nullif(btrim(coalesce(p_search, '')), '');
BEGIN
  IF NOT public.is_agent_vetting_reviewer(auth.uid()) THEN
    RAISE EXCEPTION 'Only Agent Ops can review agent verification.' USING ERRCODE = '42501';
  END IF;

  WITH base AS (
    SELECT v.*, pr.full_name, pr.phone AS profile_phone, pr.district AS profile_district
    FROM public.agent_vetting v JOIN public.profiles pr ON pr.id = v.agent_id
    WHERE (p_status IS NULL OR v.status = p_status)
      AND (NOT p_in_scope_only OR v.in_scope)
      AND (v_q IS NULL OR pr.full_name ILIKE '%' || v_q || '%' OR pr.phone ILIKE '%' || v_q || '%')
  )
  SELECT (SELECT count(*) FROM base),
         coalesce((SELECT jsonb_agg(jsonb_build_object(
            'agent_id', b.agent_id, 'name', b.full_name, 'phone', b.profile_phone, 'district', b.profile_district,
            'status', b.status, 'in_scope', b.in_scope, 'id_source', b.id_source,
            'submitted_at', b.submitted_at, 'reviewed_at', b.reviewed_at, 'review_note', b.review_note)
            ORDER BY b.submitted_at ASC NULLS LAST, b.agent_id)
          FROM (SELECT * FROM base ORDER BY submitted_at ASC NULLS LAST, agent_id
                LIMIT greatest(least(coalesce(p_limit, 50), 200), 1) OFFSET greatest(coalesce(p_offset, 0), 0)) b), '[]'::jsonb)
    INTO v_total, v_rows;

  RETURN jsonb_build_object('total', v_total, 'rows', v_rows,
    'counts', (SELECT jsonb_object_agg(status, n) FROM (
                 SELECT status, count(*) n FROM public.agent_vetting
                 WHERE NOT p_in_scope_only OR in_scope GROUP BY status) c));
END;
$$;
REVOKE ALL ON FUNCTION public.agent_vetting_queue(text, text, boolean, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_vetting_queue(text, text, boolean, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.agent_vetting_detail(p_agent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v  public.agent_vetting;
  p  public.profiles;
  h  public.profiles;
BEGIN
  IF NOT public.is_agent_vetting_reviewer(auth.uid()) THEN
    RAISE EXCEPTION 'Only Agent Ops can review agent verification.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v FROM public.agent_vetting WHERE agent_id = p_agent_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO p FROM public.profiles WHERE id = p_agent_id;
  SELECT * INTO h FROM public.profiles WHERE id = v.id_holder_id;

  RETURN to_jsonb(v)
    || jsonb_build_object(
      'name', p.full_name, 'profile_phone', p.phone, 'avatar_url', p.avatar_url,
      'gps_drift_m', CASE WHEN v.gps2_lat IS NOT NULL
                       THEN round(public.agent_vetting_distance_m(v.gps1_lat, v.gps1_lng, v.gps2_lat, v.gps2_lng)) END,
      'residence_pin', CASE WHEN p.residence_lat IS NOT NULL
                         THEN jsonb_build_object('lat', p.residence_lat, 'lng', p.residence_lng) END,
      'id_holder', CASE WHEN h.id IS NOT NULL THEN jsonb_build_object('id', h.id, 'name', h.full_name, 'phone', h.phone) END,
      'collections', (SELECT count(*) FROM public.agent_collections c WHERE c.agent_id = p_agent_id),
      'rent_requests', (SELECT count(*) FROM public.rent_requests r WHERE r.agent_id = p_agent_id),
      'events', coalesce((SELECT jsonb_agg(jsonb_build_object('event', e.event, 'actor_id', e.actor_id,
                                                              'detail', e.detail, 'at', e.created_at) ORDER BY e.created_at DESC)
                          FROM (SELECT * FROM public.agent_vetting_events WHERE agent_id = p_agent_id
                                ORDER BY created_at DESC LIMIT 50) e), '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.agent_vetting_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_vetting_detail(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.decide_agent_vetting(p_agent_id uuid, p_approve boolean, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v     public.agent_vetting;
BEGIN
  IF NOT public.is_agent_vetting_reviewer(v_uid) THEN
    RAISE EXCEPTION 'Only Agent Ops can review agent verification.' USING ERRCODE = '42501';
  END IF;
  IF v_uid = p_agent_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'You cannot review your own verification.');
  END IF;
  IF p_approve IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Choose approve or reject.');
  END IF;
  IF NOT p_approve AND coalesce(btrim(p_note), '') = '' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Tell the agent what to fix.');
  END IF;

  SELECT * INTO v FROM public.agent_vetting WHERE agent_id = p_agent_id FOR UPDATE;
  IF NOT FOUND OR v.status <> 'submitted' THEN
    RETURN jsonb_build_object('success', false, 'message', 'Only submitted verifications can be reviewed.');
  END IF;

  UPDATE public.agent_vetting SET
    status = CASE WHEN p_approve THEN 'verified' ELSE 'rejected' END,
    verified_at = CASE WHEN p_approve THEN now() END,
    reviewed_by = v_uid, reviewed_at = now(), review_note = nullif(btrim(p_note), ''), updated_at = now()
  WHERE agent_id = p_agent_id;

  PERFORM public._agent_vetting_log(p_agent_id, CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
                                    jsonb_build_object('note', nullif(btrim(p_note), '')));
  RETURN jsonb_build_object('success', true, 'status', CASE WHEN p_approve THEN 'verified' ELSE 'rejected' END);
END;
$$;
REVOKE ALL ON FUNCTION public.decide_agent_vetting(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_agent_vetting(uuid, boolean, text) TO authenticated;

-- ---------------------------------------------------------------------------------------
-- 6. The gate
-- ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_agent_vetted(p_agent_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT EXISTS (SELECT 1 FROM public.agent_vetting WHERE agent_id = p_agent_id AND status = 'verified');
$$;
REVOKE ALL ON FUNCTION public.is_agent_vetted(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_agent_vetted(uuid) TO authenticated, service_role;

-- {blocked, reason, status}. Used by register-tenant and anything else that adds a tenant.
CREATE OR REPLACE FUNCTION public.agent_vetting_gate_status(p_agent_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'enforced', g.enforced,
    'status', coalesce(v.status, 'unverified'),
    'blocked', g.enforced AND coalesce(v.status, 'unverified') <> 'verified',
    'reason', CASE
      WHEN NOT g.enforced OR v.status = 'verified' THEN NULL
      WHEN v.status = 'submitted' THEN 'Your agent verification is with Agent Ops. You can add tenants once it is approved.'
      WHEN v.status = 'rejected'  THEN 'Agent Ops sent your verification back. Fix it to add tenants and post Rent Plan requests.'
      ELSE 'Complete your agent verification to add tenants and post Rent Plan requests.' END)
  FROM (SELECT coalesce(s.enforce, false) AND (s.enforce_from IS NULL OR s.enforce_from <= now()) AS enforced
        FROM public.agent_vetting_settings s WHERE s.id) g
  LEFT JOIN public.agent_vetting v ON v.agent_id = p_agent_id;
$$;
REVOKE ALL ON FUNCTION public.agent_vetting_gate_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_vetting_gate_status(uuid) TO authenticated, service_role;

-- Every rent_requests insert by or for an agent: browser, edge functions, public form, API.
-- Same carve-outs as enforce_agent_daily_eligibility: tenant self-applications are not agent posts.
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
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_agent_vetting_on_rent_request() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_enforce_agent_vetting ON public.rent_requests;
CREATE TRIGGER trg_enforce_agent_vetting
  BEFORE INSERT ON public.rent_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_vetting_on_rent_request();

-- A verified agent whose National ID changes on the profile goes back to Agent Ops.
CREATE OR REPLACE FUNCTION public.agent_vetting_reopen_on_id_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public._agent_vetting_reopen(NEW.id, 'national_id');
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.agent_vetting_reopen_on_id_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_agent_vetting_reopen_on_id_change ON public.profiles;
CREATE TRIGGER trg_agent_vetting_reopen_on_id_change
  AFTER UPDATE OF national_id, national_id_photo_path, national_id_back_photo_path, linked_national_id ON public.profiles
  FOR EACH ROW
  WHEN (OLD.national_id IS DISTINCT FROM NEW.national_id
     OR OLD.national_id_photo_path IS DISTINCT FROM NEW.national_id_photo_path
     OR OLD.national_id_back_photo_path IS DISTINCT FROM NEW.national_id_back_photo_path
     OR OLD.linked_national_id IS DISTINCT FROM NEW.linked_national_id)
  EXECUTE FUNCTION public.agent_vetting_reopen_on_id_change();

-- ---------------------------------------------------------------------------------------
-- 7. Seed: every in-scope agent starts unverified, with next of kin defaulted to the parent
-- ---------------------------------------------------------------------------------------
WITH scope AS (
  SELECT DISTINCT ur.user_id AS agent_id
  FROM public.user_roles ur
  WHERE ur.role = 'agent'
    AND (EXISTS (SELECT 1 FROM public.rent_requests r WHERE r.agent_id = ur.user_id)
      OR EXISTS (SELECT 1 FROM public.agent_collections c WHERE c.agent_id = ur.user_id)
      OR EXISTS (SELECT 1 FROM public.agent_subagents s WHERE s.parent_agent_id = ur.user_id AND s.status = 'verified'))
), parent AS (
  SELECT DISTINCT ON (s.sub_agent_id) s.sub_agent_id, s.parent_agent_id
  FROM public.agent_subagents s
  WHERE s.status = 'verified'
  ORDER BY s.sub_agent_id, s.verified_at DESC NULLS LAST, s.created_at DESC
)
INSERT INTO public.agent_vetting (agent_id, in_scope, nok_name, nok_phone, nok_relationship, nok_source, nok_agent_id)
SELECT sc.agent_id, true, pp.full_name, pp.phone,
       CASE WHEN pp.id IS NOT NULL THEN 'Parent agent' END,
       CASE WHEN pp.id IS NOT NULL THEN 'parent_agent' END,
       pp.id
FROM scope sc
JOIN public.profiles me ON me.id = sc.agent_id
LEFT JOIN parent pa ON pa.sub_agent_id = sc.agent_id
LEFT JOIN public.profiles pp ON pp.id = pa.parent_agent_id
ON CONFLICT (agent_id) DO NOTHING;
