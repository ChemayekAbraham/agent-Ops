-- Agent vetting: accept an identity that is already verified.
--
-- The withdraw flow's rule (identity_already_verified) makes a verified account's National ID photo
-- and selfie final: IdentityPhotoCapture refuses to send them again ("Your identity is already
-- verified"). Vetting still asked those agents for a back photo / NIN they could not send, so 37 of
-- the 106 already-verified agents (and 2 without a NIN on the profile) were stuck while the block
-- is on. For an already-verified identity the ID step now passes with what is on file; the NIN may
-- come from the verification record. national_id.identity_verified tells the screen to show the
-- summary without "Replace ID photos" (the ID is final). Agent Ops sees identity_verified too.
-- CREATE OR REPLACE keeps both functions' grants.

CREATE OR REPLACE FUNCTION public._agent_vetting_id_status(p_uid uuid, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p        public.profiles;
  v_parent uuid := public._agent_vetting_parent(p_uid);
  v_holder uuid;
  v_link   public.national_id_link_requests;
  v_count  int;
  v_hname  text;
  v_vnin   text;
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

  -- Identity already verified (the withdraw flow's rule, identity_already_verified): that ID and
  -- selfie are final and the person may not send them again, so vetting accepts them as they are.
  -- The back photo is not required here, and the NIN may come from the verification record.
  IF public.identity_already_verified__impl(p_uid) THEN
    SELECT d.national_id INTO v_vnin FROM public.payout_destination_verifications d
     WHERE d.user_id = p_uid AND d.status = 'verified' AND coalesce(d.national_id, '') <> ''
     ORDER BY d.national_id_submitted_at DESC NULLS LAST LIMIT 1;
    RETURN jsonb_build_object('ok', true, 'source', 'own', 'identity_verified', true,
      'nin_masked', public.mask_national_id(coalesce(nullif(p.national_id, ''), v_vnin)),
      'front_path', p.national_id_photo_path, 'back_path', p.national_id_back_photo_path);
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
$function$;

CREATE OR REPLACE FUNCTION public.agent_vetting_detail(p_agent_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      'identity_verified', public.identity_already_verified__impl(p_agent_id),
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
$function$;
