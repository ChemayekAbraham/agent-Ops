-- An account that completes the National ID link flow (OTP to the holder's
-- number, holder consent, staff confirmation) was still hitting a completely
-- separate "duplicate National ID" auto-reject on its payout destination, and
-- staff confirming the link never touched that destination at all — leaving
-- the account rejected and staff's separate manual "call and verify payout"
-- step permanently blocked ("Blocked because this case was rejected").
--
-- Josh's instruction: once the link is staff-confirmed, that confirmation
-- itself IS the identity review. The account must be auto-verified for
-- payout, not sent through a second, independent Financial Ops verification
-- pass.

-- 1. duplicate_national_id_owner: an active (staff-confirmed) link between
--    two accounts for this NIN is legitimate sharing, not a violation. Without
--    this exclusion, the auto-reject trigger below fires again the moment
--    staff-confirm updates the destination, undoing the very decision staff
--    just made.
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
      WHERE r.status = 'active'
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
      WHERE r.status = 'active'
        AND ((r.requester_id = p_user_id AND r.holder_id = d.user_id)
          OR (r.requester_id = d.user_id AND r.holder_id = p_user_id))
    )
  ORDER BY d.created_at ASC NULLS LAST
  LIMIT 1;

  RETURN v_owner;
END;
$function$;

-- 2. national_id_link_staff_confirm: on approval, auto-verify every one of the
--    requester's non-verified payout destinations. Staff's confirmation here
--    replaces the separate manual payout-verification pass entirely for this
--    account — it does not merely unblock it.
CREATE OR REPLACE FUNCTION public.national_id_link_staff_confirm(p_request_id uuid, p_approve boolean, p_reason text)
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
  IF v_uid IS NULL
     OR NOT (public.has_role(v_uid,'financial_ops'::app_role)
             OR public.has_role(v_uid,'cfo'::app_role)
             OR public.has_role(v_uid,'super_admin'::app_role)) THEN
    RETURN jsonb_build_object('success', false, 'message', 'You are not allowed to confirm this.');
  END IF;
  IF length(v_reason) < 10 THEN
    RETURN jsonb_build_object('success', false,
      'message', 'Write at least 10 characters saying what you checked.');
  END IF;

  PERFORM public.national_id_link_expire_stale();

  SELECT * INTO r FROM public.national_id_link_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'That request was not found.');
  END IF;
  IF r.status <> 'owner_approved' THEN
    RETURN jsonb_build_object('success', false,
      'message', 'Only a request the ID holder has approved can be confirmed.');
  END IF;

  UPDATE public.national_id_link_requests
     SET status = CASE WHEN p_approve THEN 'active' ELSE 'rejected_by_staff' END,
         staff_decided_at = now(), staff_decided_by = v_uid,
         decision_reason = v_reason, updated_at = now()
   WHERE id = r.id;

  IF p_approve THEN
    UPDATE public.profiles
       SET linked_national_id = r.nin, linked_national_id_request_id = r.id
     WHERE id = r.requester_id;

    -- The link review just performed IS the identity verification for this
    -- account's payout destinations — no separate Financial Ops payout call
    -- is needed on top of it. duplicate_national_id_owner (fixed above) no
    -- longer treats this pairing as a violation now that the link is active,
    -- so this UPDATE passes trg_auto_reject_duplicate_national_id cleanly
    -- instead of being immediately re-rejected.
    WITH verified AS (
      UPDATE public.payout_destination_verifications d
         SET status = 'verified',
             decided_at = now(),
             decided_by = v_uid,
             decision_reason = 'Auto-verified: account linked to an existing National ID, confirmed by Financial Ops via the ID-link review.',
             updated_at = now()
       WHERE d.user_id = r.requester_id
         AND d.status <> 'verified'
      RETURNING d.id
    )
    SELECT count(*) INTO v_verified_count FROM verified;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (v_uid,
          CASE WHEN p_approve THEN 'national_id_link_confirmed'
               ELSE 'national_id_link_refused' END,
          'national_id_link_requests', r.id::text, v_reason,
          jsonb_build_object('approved', p_approve, 'requester_id', r.requester_id,
                             'holder_id', r.holder_id, 'payout_destinations_auto_verified', v_verified_count));

  RETURN jsonb_build_object('success', true,
    'status', CASE WHEN p_approve THEN 'active' ELSE 'rejected_by_staff' END,
    'payout_destinations_auto_verified', v_verified_count);
END;
$function$;
