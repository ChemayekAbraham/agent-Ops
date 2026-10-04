-- CTO report: stop counting "job canceled" runs on superseded cron job copies.
--
-- Lovable's platform-side email-infra provisioning (not in this repo) re-runs
-- `cron.unschedule('process-email-queue')` + `cron.schedule(...)` on deploys
-- (216x since 2026-09-17). Each run deletes the job row; if a dispatch was
-- in flight pg_cron logs it as `failed / job canceled` under a jobid that no
-- longer exists, and the CTO report surfaced it as an "(unscheduled)" failing
-- automation (2026-09-28 report, issue #10 / recommendation #1). See
-- docs/HANDOVER/151 and 152.
--
-- A run is ignored only when ALL hold:
--   * status = 'failed' and return_message = 'job canceled'
--   * its jobid is no longer in cron.job
--   * a live cron.job row runs the same command (the job was re-created)
-- A job that is deleted outright with no replacement still reports.
--
-- The three report functions are rewritten in place (live body, text swap of
-- cron.job_run_details -> public.cto_cron_run_details) rather than re-declared
-- here, because repo copies of these 20-33 KB bodies are not guaranteed to
-- match production. get_cto_daily_addendum already inner-joins cron.job and
-- never saw these rows, so it is untouched.

CREATE OR REPLACE VIEW public.cto_cron_run_details AS
SELECT d.*
FROM cron.job_run_details d
WHERE NOT (
  d.status = 'failed'
  AND d.return_message = 'job canceled'
  AND NOT EXISTS (SELECT 1 FROM cron.job j WHERE j.jobid = d.jobid)
  AND EXISTS (SELECT 1 FROM cron.job j2 WHERE btrim(j2.command) = btrim(d.command))
);

REVOKE ALL ON public.cto_cron_run_details FROM PUBLIC, anon, authenticated;

COMMENT ON VIEW public.cto_cron_run_details IS
  'cron.job_run_details minus "job canceled" runs on superseded job copies (job re-created with the same command). Read by the CTO report functions only. Doc 152.';

DO $$
DECLARE
  v_sig text;
  v_def text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.get_cto_daily_report(date)',
    'public.get_cto_diagnostics(date)',
    'public.get_cto_issue_intelligence(date)'
  ] LOOP
    v_def := pg_get_functiondef(v_sig::regprocedure);
    IF position('cron.job_run_details' IN v_def) = 0 THEN
      RAISE EXCEPTION '% no longer reads cron.job_run_details; re-check before rewriting', v_sig;
    END IF;
    EXECUTE replace(v_def, 'cron.job_run_details', 'public.cto_cron_run_details');
  END LOOP;
END $$;

-- Re-baseline drift detection in the same migration (deliberate change).
UPDATE public.critical_function_baselines
SET expected_sha256 = encode(sha256(convert_to(pg_get_functiondef(function_signature::regprocedure), 'UTF8')), 'hex'),
    baselined_at = now(),
    baselined_by = '20260929120000_cto_report_ignore_superseded_cron_cancels.sql',
    note = 'Deliberate change 2026-09-29 (doc 152): cron failures read from public.cto_cron_run_details, which drops "job canceled" runs on superseded job copies (Lovable email-infra re-provisioning).'
WHERE function_signature IN ('get_cto_daily_report(date)', 'get_cto_diagnostics(date)', 'get_cto_issue_intelligence(date)');
