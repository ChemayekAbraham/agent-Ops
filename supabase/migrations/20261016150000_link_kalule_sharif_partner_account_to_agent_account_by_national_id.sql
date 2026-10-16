-- Staff-created National ID link: KALULE SHARIF partner account (3f87c1f3, sharifkc264@gmail.com)
-- -> SHARIFU KALULE agent account (98ee118b, kalulesharif618@gmail.com, +256757229748).
--
-- WHY: the partner account's withdrawals (3,000,000 + 1,000,000 to 0757229748) cannot be
-- claimed by Merchant Agents: the doc 211 gate wants 0757229748 verified for that user, and
-- the destination was auto-rejected as a duplicate National ID (the same person's other
-- account). A link between the two accounts stops them counting as duplicates
-- (duplicate_national_id_owner skips linked pairs) and the staff-confirm effects verify the
-- requester's destinations.
--
-- HOW THIS DIFFERS FROM THE NORMAL FLOW: the holder's OTP and in-app approval were NOT
-- collected. Josh Wanda (CFO) explicitly approved skipping holder consent on 2026-10-16 after
-- tracing the identity: both profiles carry the same National ID (CMO305210NU9EC /
-- CM0305210NU9EC, identical under normalize_national_id_fuzzy), the names match (name match
-- 1.00), 0757229748 is verified on the agent account and is the number he withdrew to, and
-- 3,000,000 was moved from the agent account to the partner account on 2026-09-30 ("agent
-- partnership"). owner_decision is left NULL on purpose so the record does not claim the
-- holder consented; decision_reason says so. Everything else mirrors
-- national_id_link_staff_confirm(approve).
--
-- Idempotent: does nothing if an owner_approved/active link already exists for the pair.
-- Revoke with the normal unlink flow (request_national_id_unlink / decide_national_id_unlink).
DO $$
DECLARE
  v_req    uuid := '3f87c1f3-6564-478d-a08d-43da24614c80';
  v_holder uuid := '98ee118b-06d1-47a4-aa2b-76bd12170b70';
  v_by     uuid := 'cb798acb-68bc-4b4e-a414-a3d374e030b6';
  v_nin    text := 'CMO305210NU9EC';
  v_reason text := 'Staff-created link by Josh Wanda (CFO), 2026-10-16: same person as the holder (same National ID incl. O/0 variant, names match, 0757229748 verified on holder account, 3M agent-partnership transfer 2026-09-30). Holder OTP and in-app approval not collected; CFO approved skipping holder consent.';
  v_id     uuid;
  v_verified integer := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.national_id_link_requests r
    WHERE r.status IN ('owner_approved', 'active')
      AND r.requester_id = v_req AND r.holder_id = v_holder
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.national_id_link_requests
    (requester_id, holder_id, nin, nin_fuzzy, status, staff_decided_at, staff_decided_by,
     decision_reason, holder_phone)
  VALUES
    (v_req, v_holder, v_nin, public.normalize_national_id_fuzzy(v_nin), 'active', now(), v_by,
     v_reason, (SELECT phone FROM public.profiles WHERE id = v_holder))
  RETURNING id INTO v_id;

  UPDATE public.profiles
     SET linked_national_id = v_nin, linked_national_id_request_id = v_id
   WHERE id = v_req;

  WITH verified AS (
    UPDATE public.payout_destination_verifications d
       SET status = 'verified',
           decided_at = now(),
           decided_by = v_by,
           decision_reason = 'Verified by Financial Ops: partner account linked to the holder National ID (staff-created link ' || v_id::text || ').',
           updated_at = now()
     WHERE d.user_id = v_req
       AND d.status <> 'verified'
    RETURNING d.id
  )
  SELECT count(*) INTO v_verified FROM verified;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (v_by, 'national_id_link_confirmed', 'national_id_link_requests', v_id::text, v_reason,
          jsonb_build_object('approved', true, 'requester_id', v_req, 'holder_id', v_holder,
                             'payout_destinations_auto_verified', v_verified,
                             'staff_created', true, 'holder_consent_collected', false));
END $$;
