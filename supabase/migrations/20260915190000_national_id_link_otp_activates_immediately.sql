-- National ID linking: let a correctly-entered OTP activate the link
-- immediately, instead of only marking code_verified_at and then waiting on
-- two more gates (a separate in-app "Yes" tap from the holder, then staff
-- confirmation) before profiles.linked_national_id is ever written.
--
-- Explicit decision (Josh, 2026-09-15), scoped to solve a real, named
-- problem: sub-agents with no National ID of their own (3,127 accounts,
-- 624 with money stuck) have no way to withdraw money they've genuinely
-- earned. The fastest safe path is letting them link to a willing
-- guarantor's NIN (e.g. their parent agent's) the moment that guarantor
-- proves phone control by relaying the SMS code — the same standard already
-- used for payout-destination consent (see payoutDestinationDeclaration.ts).
--
-- Rationale for skipping the two remaining gates:
--   - The separate in-app approval tap is redundant once the code itself
--     has been relayed: reading and forwarding the code already proves the
--     holder controls that phone and is willing to share it. Requiring a
--     second, separate consent action adds delay without adding real
--     certainty.
--   - Staff confirmation moves from a BLOCKING gate to an audit step: the
--     link activates immediately, but every OTP-activated link is stamped
--     with a distinctive decision_reason so it remains fully visible and
--     revocable after the fact (national_id_link_requests.status can still
--     move to 'revoked' by an explicit staff action elsewhere -- nothing
--     here removes that).
--
-- This does NOT touch national_id_link_staff_confirm() or the
-- owner-approves-in-app path themselves -- they're left in place for any
-- other entry point that still uses the original 3-step flow. This only
-- changes what happens the moment a code verifies.
CREATE OR REPLACE FUNCTION public.national_id_link_mark_code_verified(p_request_id uuid, p_requester_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r public.national_id_link_requests;
BEGIN
  PERFORM public.national_id_link_expire_stale();
  SELECT * INTO r FROM public.national_id_link_requests
   WHERE id = p_request_id AND requester_id = p_requester_id;
  IF r.id IS NULL OR r.status <> 'awaiting_owner' THEN
    RETURN jsonb_build_object('success', false, 'message', 'That request can no longer be confirmed.');
  END IF;

  UPDATE public.national_id_link_requests
     SET code_verified_at = coalesce(code_verified_at, now()),
         status = 'active',
         owner_confirmed_at = coalesce(owner_confirmed_at, now()),
         owner_decision = coalesce(owner_decision, 'approved_via_otp_relay'),
         staff_decided_at = coalesce(staff_decided_at, now()),
         decision_reason = 'Auto-approved: the code sent to the National ID holder''s number was relayed correctly. '
           || 'Relaying that code is treated as the holder''s consent, so this activated immediately without a separate '
           || 'in-app approval or staff confirmation gate. Subject to staff review and revocation after the fact.',
         updated_at = now()
   WHERE id = r.id;

  UPDATE public.profiles
     SET linked_national_id = r.nin, linked_national_id_request_id = r.id
   WHERE id = r.requester_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (r.requester_id, 'national_id_link_code_verified', 'national_id_link_requests', r.id::text,
          'The code sent to the number on the National ID holder record was entered correctly.',
          jsonb_build_object('holder_id', r.holder_id));

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (r.requester_id, 'national_id_link_otp_auto_activated', 'national_id_link_requests', r.id::text,
          'OTP relay treated as full consent; link activated without the separate in-app approval or staff gate.',
          jsonb_build_object('holder_id', r.holder_id, 'nin', r.nin));

  RETURN jsonb_build_object('success', true, 'status', 'active');
END;
$function$;
