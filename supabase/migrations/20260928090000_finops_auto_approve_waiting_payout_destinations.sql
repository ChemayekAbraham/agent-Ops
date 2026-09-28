-- Doc 143: everything waiting in the Financial Ops phone-verification queue is
-- verified automatically every 10 minutes.
--
-- Josh (2026-09-28): "whoever is on waiting, on phone verification on
-- Financial Ops create a cron job to run every 10 minutes it should verify
-- automatically". This makes the doc-137 one-off bulk approval permanent.
--
-- Scope is exactly the queue Financial Ops sees (finops_payout_verification_counts.waiting):
--   status = 'waiting', ID photo + selfie on file, not a portfolio funder,
--   not in mv_identity_double_users.
-- Rows without an ID photo and selfie are NOT touched: they never reached the queue.
--
-- Order per run:
--   1. auto_verify_waiting_payout_destinations(NULL) - the doc-136 rules, which
--      also register the ID name on the profile when the name matches.
--   2. Everything still waiting in the queue is set to 'verified', one audit row
--      each (old status/reason kept for reversal).
-- trg_auto_reject_duplicate_national_id still runs on the UPDATE, so a National ID
-- already used on another account is rejected instead of verified.
-- enforce_withdrawal_payout_account_lock is unchanged.

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
      AND x.user_id IS NULL
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

-- One job does both steps, so the old rules-only job is replaced.
DO $$
BEGIN
  PERFORM cron.unschedule('auto-verify-waiting-payout-destinations')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-verify-waiting-payout-destinations');
  PERFORM cron.unschedule('finops-auto-approve-waiting-payout-destinations')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'finops-auto-approve-waiting-payout-destinations');
END $$;

SELECT cron.schedule(
  'finops-auto-approve-waiting-payout-destinations',
  '*/10 * * * *',
  $$SELECT public.finops_auto_approve_waiting_payout_destinations()$$
);
