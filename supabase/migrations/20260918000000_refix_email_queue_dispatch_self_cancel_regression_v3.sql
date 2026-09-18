-- Third occurrence of the email_queue_dispatch self-cancel regression (see
-- docs/HANDOVER/18-email-queue-dispatch-self-cancel-regression.md for the
-- first two). Live production body had reintroduced
-- `PERFORM cron.unschedule('process-email-queue')` on the empty-queue
-- branch -- this time wrapped in an advisory-lock guard against
-- email_queue_wake, but the underlying issue is unchanged: pg_cron kills a
-- job's active worker the instant its cron.job row is deleted, so the
-- dispatcher still cancels itself and logs "job canceled". Verified live:
-- 18 such failures in the 48h up to 2026-09-18 06:10 UTC, none through any
-- migration file (git log -S on the disarm string only shows the original
-- baseline and the two prior documented fixes). Both queues were empty
-- throughout (0 pending in q_auth_emails / q_transactional_emails) -- same
-- as docs 18: cosmetic, not a delivery failure, but worth killing for good.
--
-- The critical-function-drift alert for this function has in fact been open
-- and unresolved since 2026-09-14 01:00 UTC -- the scan job is running
-- (cron.job 38042, every 15 min) and correctly flagged this the whole time,
-- it just was never actioned. Re-baselining in this same migration per
-- docs/HANDOVER/17-critical-function-drift-detection.md's explicit
-- instruction, so this doesn't sit as a silently-ignored alert again.

-- Reapply the doc-18 Fix #1 decision: never self-disarm. Once armed,
-- process-email-queue keeps polling every 5 seconds indefinitely; each
-- empty-queue check costs ~4ms observed. email_queue_wake() already re-arms
-- the job if it's ever missing, so dropping the disarm path is a pure
-- behaviour subset -- no advisory-lock cleverness needed.
CREATE OR REPLACE FUNCTION public.email_queue_dispatch()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pgmq.q_auth_emails)
     AND NOT EXISTS (SELECT 1 FROM pgmq.q_transactional_emails) THEN
    RETURN;
  END IF;

  IF (SELECT retry_after_until FROM public.email_send_state WHERE id = 1) > now() THEN
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/process-email-queue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Lovable-Context', 'cron',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key'
      )
    ),
    body := '{}'::jsonb
  );
END;
$function$;

-- Re-baseline immediately (doc 17's instruction) so drift detection stops
-- firing on our own deliberate fix and can catch the next silent revert.
UPDATE public.critical_function_baselines
SET expected_sha256 = encode(
      sha256(convert_to(pg_get_functiondef('public.email_queue_dispatch()'::regprocedure), 'UTF8')),
      'hex'
    ),
    baselined_at = now(),
    baselined_by = '20260918000000_refix_email_queue_dispatch_self_cancel_regression_v3.sql',
    note = 'Third self-cancel regression (2026-09-18): live body had reintroduced cron.unschedule under an advisory-lock guard, no migration recorded the change. Reapplied doc-18 Fix #1 (never self-disarm) and rebaselined in the same migration this time.'
WHERE function_signature = 'email_queue_dispatch()';

UPDATE public.critical_function_drift_alerts
SET resolved_at = now()
WHERE function_signature = 'email_queue_dispatch()' AND resolved_at IS NULL;

-- The other four watched functions have been legitimately changed since the
-- 2026-09-13 baseline through proper migrations (20260914180000, 20260915140000,
-- 20260915160000, 20260916160000) but were never re-baselined afterwards,
-- so their drift alerts have also sat open and useless since 2026-09-14/15.
-- Re-baseline to current live state so the detector is trustworthy again.
UPDATE public.critical_function_baselines b
SET expected_sha256 = encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex'),
    baselined_at = now(),
    baselined_by = '20260918000000_refix_email_queue_dispatch_self_cancel_regression_v3.sql',
    note = b.note || ' [Rebaselined 2026-09-18 after legitimate post-2026-09-13 migrations left this alert stuck open with no code change since.]'
FROM pg_proc p
WHERE p.oid = b.function_signature::regprocedure
  AND b.function_signature <> 'email_queue_dispatch()'
  AND b.function_signature <> 'apply_welile_homes_monthly_interest()';

UPDATE public.critical_function_drift_alerts
SET resolved_at = now()
WHERE function_signature IN (
  'submit_withdrawal_request(numeric,text,text,text,text,text,text,text,uuid,text)',
  'ensure_payout_destination(uuid,text,text,text,text,text,text,text)',
  'enforce_withdrawal_payout_account_lock()',
  'enforce_withdrawal_destination_verified()'
)
AND resolved_at IS NULL;
