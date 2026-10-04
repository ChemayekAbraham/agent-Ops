-- Follow-up to 20260919160000. Josh: "even when the owner of the ID accepts
-- that user is auto verified, no more manual verify[ing]." The previous
-- migration only auto-verified payout destinations when STAFF confirmed the
-- link (national_id_link_staff_confirm), which still made the account wait
-- on a second gate after the holder had already said yes. Moving the
-- auto-verify to the OWNER's approval itself — staff's later "Confirm the
-- link" step becomes a review/audit record, not a blocking gate for payout.

-- 1. duplicate_national_id_owner: the exclusion must also cover
--    'owner_approved', not just 'active' — otherwise a resubmission made in
--    the window between owner approval and staff's (now non-blocking) review
--    would still get auto-rejected by the trigger.
CREATE OR REPLACE FUNCTION public.duplicate_national_id_owner(p_user_id uuid, p_national_id text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_strict text := upper(regexp_replace(coalesce(p_national_id, ''), '[^A-Za-z0-9]', '', 'g'));
  v_fuzzy  text := public.normalize_national_id_fuzzy(p_national_id);
  v_owner  uuid;
BEGIN
  IF length(v_strict) < 6 THEN
    RETURN NULL;
  END IF;

  SELECT p.id INTO v_owner
  FROM public.profiles p
  WHERE p.id IS DISTINCT FROM p_user_id
    AND coalesce(p.national_id, '') <> ''
    AND public.normalize_national_id_fuzzy(p.national_id) = v_fuzzy
    AND NOT EXISTS (
      SELECT 1 FROM public.national_id_link_requests r
      WHERE r.status IN ('owner_approved', 'active')
        AND ((r.requester_id = p_user_id AND r.holder_id = p.id)
          OR (r.requester_id = p.id AND r.holder_id = p_user_id))
    )
  ORDER BY p.created_at ASC NULLS LAST, p.id ASC
  LIMIT 1;

  IF v_owner IS NOT NULL THEN
    RETURN v_owner;
  END IF;

  SELECT d.user_id INTO v_owner
  FROM public.payout_destination_verifications d
  WHERE d.user_id IS DISTINCT FROM p_user_id
    AND d.status = 'verified'
    AND coalesce(d.national_id, '') <> ''
    AND public.normalize_national_id_fuzzy(d.national_id) = v_fuzzy
    AND NOT EXISTS (
      SELECT 1 FROM public.national_id_link_requests r
      WHERE r.status IN ('owner_approved', 'active')
        AND ((r.requester_id = p_user_id AND r.holder_id = d.user_id)
          OR (r.requester_id = d.user_id AND r.holder_id = p_user_id))
    )
  ORDER BY d.created_at ASC NULLS LAST
  LIMIT 1;

  RETURN v_owner;
END;
$function$;

-- 2. national_id_link_owner_decision: on approval, record the link on the
--    requester's profile and auto-verify their payout destinations
--    immediately — the same block previously added to staff_confirm, moved
--    one step earlier. Staff confirming afterward (national_id_link_staff_confirm,
--    unchanged) finds the destinations already verified and its own auto-verify
--    UPDATE simply matches zero rows — a harmless no-op, kept as a safety net
--    for a request that somehow reaches 'active' without ever passing through
--    this path.
CREATE OR REPLACE FUNCTION public.national_id_link_owner_decision(p_request_id uuid, p_approve boolean, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  r public.national_id_link_requests;
  v_reason text := btrim(coalesce(p_reason,''));
  v_verified_count integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Please sign in again.');
  END IF;
  PERFORM public.national_id_link_expire_stale();

  SELECT * INTO r FROM public.national_id_link_requests
   WHERE id = p_request_id AND holder_id = v_uid;
  IF r.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'That request was not found.');
  END IF;
  IF r.status <> 'awaiting_owner' THEN
    RETURN jsonb_build_object('success', false, 'message', 'That request has already been answered.');
  END IF;

  IF p_approve THEN
    IF r.code_verified_at IS NULL THEN
      RETURN jsonb_build_object('success', false,
        'message', 'The person asking has not yet entered the code sent to your number.');
    END IF;
    UPDATE public.national_id_link_requests
       SET status = 'owner_approved', owner_decision = 'approved',
           owner_confirmed_at = now(), updated_at = now()
     WHERE id = r.id;

    UPDATE public.profiles
       SET linked_national_id = r.nin, linked_national_id_request_id = r.id
     WHERE id = r.requester_id;

    WITH verified AS (
      UPDATE public.payout_destination_verifications d
         SET status = 'verified',
             decided_at = now(),
             decided_by = NULL,
             decision_reason = 'Auto-verified: the National ID holder approved linking this account in the app.',
             updated_at = now()
       WHERE d.user_id = r.requester_id
         AND d.status <> 'verified'
      RETURNING d.id
    )
    SELECT count(*) INTO v_verified_count FROM verified;
  ELSE
    UPDATE public.national_id_link_requests
       SET status = 'rejected_by_owner', owner_decision = 'rejected',
           owner_confirmed_at = now(),
           decision_reason = nullif(v_reason,''), updated_at = now()
     WHERE id = r.id;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (v_uid,
          CASE WHEN p_approve THEN 'national_id_link_owner_approved'
               ELSE 'national_id_link_owner_rejected' END,
          'national_id_link_requests', r.id::text,
          'The National ID holder answered the in-app request to link another account.',
          jsonb_build_object('approved', p_approve, 'requester_id', r.requester_id,
                             'note', nullif(v_reason,''),
                             'payout_destinations_auto_verified', v_verified_count));

  RETURN jsonb_build_object('success', true,
    'status', CASE WHEN p_approve THEN 'owner_approved' ELSE 'rejected_by_owner' END,
    'payout_destinations_auto_verified', v_verified_count);
END;
$function$;
