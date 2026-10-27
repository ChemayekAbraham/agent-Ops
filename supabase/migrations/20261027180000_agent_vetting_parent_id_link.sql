-- Agent vetting: link to the parent agent's National ID without typing it.
--
-- An agent with no ID of their own may be vetted on their parent agent's ID (20 accounts per ID).
-- request_national_id_link needs the holder's NIN typed in, which a sub-agent won't know, and
-- national_id_link_state returns the full NIN to the requester. These two RPCs start and read the
-- same national_id_link_requests row for the parent, never returning more than a masked NIN.
-- Consent is unchanged: national-id-link-otp texts the code to the parent (send/verify by
-- request_id), then the parent answers Yes in the app (national_id_link_owner_decision), which
-- makes the request 'active' and sets profiles.linked_national_id.

CREATE OR REPLACE FUNCTION public.agent_vetting_request_parent_id_link()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
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
   WHERE nin_fuzzy = v_fuzzy AND status = 'active';
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
$$;
REVOKE ALL ON FUNCTION public.agent_vetting_request_parent_id_link() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_vetting_request_parent_id_link() TO authenticated;

-- Latest link request to the parent: where it stands, masked.
CREATE OR REPLACE FUNCTION public.agent_vetting_parent_id_link_state()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_uid    uuid := public._agent_vetting_require_agent();
  v_parent uuid := public._agent_vetting_parent(v_uid);
  r        public.national_id_link_requests;
BEGIN
  IF v_parent IS NULL THEN
    RETURN jsonb_build_object('found', false, 'has_parent', false);
  END IF;
  SELECT * INTO r FROM public.national_id_link_requests
   WHERE requester_id = v_uid AND holder_id = v_parent
   ORDER BY created_at DESC LIMIT 1;
  IF r.id IS NULL THEN
    RETURN jsonb_build_object('found', false, 'has_parent', true);
  END IF;
  RETURN jsonb_build_object('found', true, 'has_parent', true,
    'request_id', r.id, 'status', r.status,
    'code_sent_at', r.code_sent_at, 'code_verified_at', r.code_verified_at,
    'owner_confirmed_at', r.owner_confirmed_at, 'decision_reason', r.decision_reason,
    'expires_at', r.expires_at, 'nin_masked', public.mask_national_id(r.nin));
END;
$$;
REVOKE ALL ON FUNCTION public.agent_vetting_parent_id_link_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_vetting_parent_id_link_state() TO authenticated;
