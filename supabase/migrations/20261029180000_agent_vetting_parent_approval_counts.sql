-- Agent vetting: the parent's approval is enough for the ID step.
--
-- Since 20260919161500 a National ID link is in force once the ID holder approves it
-- ('owner_approved'); Financial Ops' later "Confirm the link" (-> 'active') is an audit, not
-- a gate. Vetting still demanded 'active', so agents whose parent had approved sat on
-- "Waiting for <parent> to approve" until a staff member happened to confirm the link
-- (3 agents on 2026-10-29). Agent Ops still reviews every agent before verifying them.
--
-- _agent_vetting_id_status: accept 'owner_approved' as well as 'active', and count both
--   toward the 20-per-ID cap.
-- agent_vetting_request_parent_id_link: count both toward the cap at request time too, so
--   parent-approved links can't push an ID past 20.
-- Both rebuilt from the live definitions (CREATE OR REPLACE keeps grants).

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
     WHERE requester_id = p_uid AND holder_id = v_parent AND status IN ('owner_approved', 'active')
     ORDER BY updated_at DESC LIMIT 1;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason',
        'Ask to be linked to your parent agent''s National ID. They must confirm the code and approve it in the app.');
    END IF;
    -- request_national_id_link counts at request time only; recount here. Parent-approved links
    -- count too: they are in force (the staff confirm after it is an audit, not a gate).
    SELECT 1 + count(*) INTO v_count FROM public.national_id_link_requests
     WHERE nin_fuzzy = v_link.nin_fuzzy AND status IN ('owner_approved', 'active');
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

CREATE OR REPLACE FUNCTION public.agent_vetting_request_parent_id_link()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid      uuid := public._agent_vetting_require_agent();
  v_parent   uuid := public._agent_vetting_parent(v_uid);
  pp         public.profiles;
  v_nin      text;
  v_fuzzy    text;
  v_existing public.national_id_link_requests;
  v_count    int;
  v_id       uuid;
BEGIN
  PERFORM public._agent_vetting_ensure(v_uid);
  IF v_parent IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'You have no parent agent, so you need your own National ID.');
  END IF;
  SELECT * INTO pp FROM public.profiles WHERE id = v_parent;
  v_nin := upper(regexp_replace(coalesce(pp.national_id, ''), '[^A-Za-z0-9]', '', 'g'));
  IF v_nin !~ '^[A-Z0-9]{12,16}$' THEN
    RETURN jsonb_build_object('success', false, 'message',
      'Your parent agent has no National ID on file yet. Ask them to add theirs, or use your own.');
  END IF;

  PERFORM public.national_id_link_expire_stale();
  v_fuzzy := public.normalize_national_id_fuzzy(v_nin);

  SELECT * INTO v_existing FROM public.national_id_link_requests
   WHERE requester_id = v_uid AND holder_id = v_parent
     AND status IN ('awaiting_owner', 'owner_approved', 'active')
   ORDER BY created_at DESC LIMIT 1;
  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'request_id', v_existing.id, 'status', v_existing.status,
      'reused', true, 'nin_masked', public.mask_national_id(v_existing.nin), 'holder_name', pp.full_name);
  END IF;

  -- One request at a time per ID from this path. Approvals can still race past 20 (the owner
  -- decision doesn't recount), so submit_agent_vetting recounts before accepting the link.
  PERFORM pg_advisory_xact_lock(hashtext('national_id_link:' || v_fuzzy));
  SELECT 1 + count(*) INTO v_count FROM public.national_id_link_requests
   WHERE nin_fuzzy = v_fuzzy AND status IN ('owner_approved', 'active');
  IF v_count >= 20 THEN
    RETURN jsonb_build_object('success', false, 'full', true, 'accounts_on_id', v_count,
      'message', 'Your parent agent''s National ID is already used by 20 accounts. Please use your own National ID.');
  END IF;

  INSERT INTO public.national_id_link_requests (requester_id, holder_id, nin, nin_fuzzy)
  VALUES (v_uid, v_parent, v_nin, v_fuzzy)
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (v_uid, 'national_id_link_requested', 'national_id_link_requests', v_id::text,
          'Agent asked to be linked to their parent agent''s National ID for agent verification.',
          jsonb_build_object('holder_id', v_parent, 'via', 'agent_vetting'));
  PERFORM public._agent_vetting_log(v_uid, 'parent_id_link_requested', jsonb_build_object('request_id', v_id));

  RETURN jsonb_build_object('success', true, 'request_id', v_id, 'status', 'awaiting_owner',
    'nin_masked', public.mask_national_id(v_nin), 'holder_name', pp.full_name, 'accounts_on_id', v_count);
END;
$function$;
