-- Agent vetting: send the parent-ID code to the parent agent's own account.
--
-- Since 20261104120000 "Ask" reuses any open request for the parent's National ID. When that
-- request was opened (elsewhere) against the same person's second account, the code went to
-- that account, which may have no phone ("The account holding that ID has no phone number on
-- record"), e.g. Ssebulime Julius -> KALULE SHARIF instead of his parent SHARIFU KALULE.
--
-- agent_vetting_request_parent_id_link: an open request for the parent's NIN aimed at another
-- account that has not had its code confirmed is cancelled (cancelled_by_requester, reason
-- recorded, vetting event parent_id_link_redirected) and a new request to the parent account
-- is created. A request already past the code (code confirmed, owner_approved, active) is
-- still reused. Rebuilt from the live definition (CREATE OR REPLACE keeps grants).

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
   -- Match on the ID, not the holder account: the same person can hold the NIN on a second
   -- account, and the unique index national_id_link_one_open is per (requester, nin_fuzzy).
   WHERE requester_id = v_uid AND nin_fuzzy = v_fuzzy
     AND status IN ('awaiting_owner', 'owner_approved', 'active')
   ORDER BY created_at DESC LIMIT 1;
  -- An unconfirmed request for this ID aimed at another account (the same person's second
  -- account, often with no phone) can never reach the parent: close it and ask the parent
  -- account instead. A request that already got past the code stays as it is.
  IF v_existing.id IS NOT NULL AND v_existing.holder_id <> v_parent
     AND v_existing.status = 'awaiting_owner' AND v_existing.code_verified_at IS NULL THEN
    UPDATE public.national_id_link_requests
       SET status = 'cancelled_by_requester',
           decision_reason = 'Replaced by a request to the parent agent''s account.',
           updated_at = now()
     WHERE id = v_existing.id;
    PERFORM public._agent_vetting_log(v_uid, 'parent_id_link_redirected',
      jsonb_build_object('from_request_id', v_existing.id, 'from_holder_id', v_existing.holder_id));
    v_existing := NULL;
  END IF;
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
