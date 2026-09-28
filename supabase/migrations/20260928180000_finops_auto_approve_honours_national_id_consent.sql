-- Doc 143 follow-up: a National ID shared with the owner's consent must not keep
-- a destination out of the 10-minute auto-approve.
--
-- Josh (2026-09-28): "A National ID already used on another account SHOULD NOT BE
-- rejected IF THE OWNER HAS CONSENTED".
--
-- Rejection already honours consent: duplicate_national_id_owner() skips any
-- account paired with the user through national_id_link_requests in
-- 'owner_approved' or 'active', so trg_auto_reject_duplicate_national_id does not
-- fire for them. The gap was the queue filter here: mv_identity_double_users
-- ignores consent, so a consented user stayed 'waiting' forever. Only the
-- double-user exclusion changes: a double whose first account is linked to it by
-- a consented request is let through. Everything else is identical to
-- 20260928090000. identity_double_submission() and the view are left alone
-- because other gates read them.

CREATE OR REPLACE FUNCTION public.finops_auto_approve_waiting_payout_destinations()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rules integer := 0;
  v_verified integer := 0;
  v_rejected integer := 0;
BEGIN
  BEGIN
    v_rules := public.auto_verify_waiting_payout_destinations(NULL);
  EXCEPTION WHEN others THEN
    RAISE WARNING 'finops_auto_approve: rule sweep failed: %', SQLERRM;
  END;

  WITH funders AS (
    SELECT DISTINCT ip.investor_id AS user_id
    FROM public.investor_portfolios ip
    WHERE lower(coalesce(ip.status, '')) NOT IN ('cancelled', 'rejected', 'deleted')
  ), queue AS (
    SELECT d.id, d.status, d.decision_reason, d.decided_by, d.decided_at
    FROM public.payout_destination_verifications d
    JOIN public.profiles p ON p.id = d.user_id
    LEFT JOIN funders f ON f.user_id = d.user_id
    LEFT JOIN public.mv_identity_double_users x ON x.user_id = d.user_id
    WHERE d.status = 'waiting'
      AND p.national_id_photo_path IS NOT NULL
      AND p.selfie_photo_path IS NOT NULL
      AND f.user_id IS NULL
      AND (x.user_id IS NULL
           OR EXISTS (
             SELECT 1 FROM public.national_id_link_requests r
             WHERE r.status IN ('owner_approved', 'active')
               AND ((r.requester_id = x.user_id AND r.holder_id = x.first_user_id)
                 OR (r.requester_id = x.first_user_id AND r.holder_id = x.user_id))))
    FOR UPDATE OF d SKIP LOCKED
  ), upd AS (
    UPDATE public.payout_destination_verifications d
       SET status = 'verified',
           decided_at = now(),
           decided_by = NULL,
           decision_reason = 'Auto-approved by the 10-minute Financial Ops queue sweep (handover doc 143).'
      FROM queue q
     WHERE d.id = q.id
    RETURNING d.id, d.user_id, d.status AS new_status, d.destination_key, d.account_name,
              q.status AS old_status, q.decision_reason AS old_reason,
              q.decided_by AS old_decided_by, q.decided_at AS old_decided_at
  ), aud AS (
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
    SELECT u.user_id, 'payout_destination_queue_auto_approved', 'payout_destination_verifications', u.id::text,
           'Financial Ops queue auto-approved by the 10-minute sweep (doc 143).',
           jsonb_build_object('status', u.old_status, 'decision_reason', u.old_reason,
                              'decided_by', u.old_decided_by, 'decided_at', u.old_decided_at),
           jsonb_build_object('status', u.new_status, 'destination_key', u.destination_key,
                              'account_name', u.account_name,
                              'source', 'finops_auto_approve_waiting_payout_destinations')
    FROM upd u
    RETURNING 1
  )
  SELECT count(*) FILTER (WHERE new_status = 'verified'),
         count(*) FILTER (WHERE new_status = 'rejected')
    INTO v_verified, v_rejected
  FROM upd;

  RETURN jsonb_build_object('rule_verified', v_rules,
                            'queue_verified', v_verified,
                            'duplicate_id_rejected', v_rejected);
END;
$function$;

REVOKE ALL ON FUNCTION public.finops_auto_approve_waiting_payout_destinations() FROM PUBLIC, anon, authenticated;
