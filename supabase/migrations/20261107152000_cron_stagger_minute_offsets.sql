-- Cron stagger: same frequency, shifted minute offsets only. No function, data or DDL change.
-- Before -> after (UTC):
--   refresh-identity-double-users-5m                   */5 * * * *    -> 2-59/5 * * * *
--   finops-auto-approve-waiting-payout-destinations    */10 * * * *   -> 4-59/10 * * * *
--   reconcile-evidenced-withdrawal-settlements         */10 * * * *   -> 3-59/10 * * * *
--   reconcile-wallets-from-pivot                       */10 * * * *   -> 7-59/10 * * * *
--   refresh-house-location-rollup                      */10 * * * *   -> 8-59/10 * * * *
--   reconcile-merchant-payout-funding                  */10 * * * *   -> 9-59/10 * * * *
--   tops-allocate-pending-collections-every-10min      */10 * * * *   -> 2-59/10 * * * *
--   tops-detect-collection-anomalies-every-10min       */10 * * * *   -> 4-59/10 * * * *
--   refresh-mv-ops-daily-summary                       */5 * * * *    -> 3-59/5 * * * *
--   refresh-agent-team-daily-collection-stats          */15 * * * *   -> 13-59/15 * * * *
--   tppo-refresh-daily-snapshot                        */15 * * * *   -> 9-59/15 * * * *
--   auto-reject-unmatched-deposits                     */15 * * * *   -> 7-59/15 * * * *
--   detect-merchant-float-variances                    */30 * * * *   -> 17-59/30 * * * *
--   scan-bot-referral-rings                            */30 * * * *   -> 19-59/30 * * * *
--   tops-build-plan-schedules-every-30min              */30 * * * *   -> 21-59/30 * * * *
-- Reserved and left alone: repair 5,20,35,50 | projection 10,25,40,55 | credit */15 | landlord hub 1-59/5 | */2 email jobs | */3 wallet totals.
DO $$
DECLARE
  r record;
  v_id bigint;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('refresh-identity-double-users-5m', '2-59/5 * * * *'),
    ('finops-auto-approve-waiting-payout-destinations', '4-59/10 * * * *'),
    ('reconcile-evidenced-withdrawal-settlements', '3-59/10 * * * *'),
    ('reconcile-wallets-from-pivot', '7-59/10 * * * *'),
    ('refresh-house-location-rollup', '8-59/10 * * * *'),
    ('reconcile-merchant-payout-funding', '9-59/10 * * * *'),
    ('tops-allocate-pending-collections-every-10min', '2-59/10 * * * *'),
    ('tops-detect-collection-anomalies-every-10min', '4-59/10 * * * *'),
    ('refresh-mv-ops-daily-summary', '3-59/5 * * * *'),
    ('refresh-agent-team-daily-collection-stats', '13-59/15 * * * *'),
    ('tppo-refresh-daily-snapshot', '9-59/15 * * * *'),
    ('auto-reject-unmatched-deposits', '7-59/15 * * * *'),
    ('detect-merchant-float-variances', '17-59/30 * * * *'),
    ('scan-bot-referral-rings', '19-59/30 * * * *'),
    ('tops-build-plan-schedules-every-30min', '21-59/30 * * * *')
  ) AS t(jobname, new_schedule)
  LOOP
    SELECT jobid INTO v_id FROM cron.job WHERE jobname = r.jobname;
    IF v_id IS NULL THEN
      RAISE NOTICE 'cron stagger: job % not found, skipped', r.jobname;
      CONTINUE;
    END IF;
    PERFORM cron.alter_job(job_id := v_id, schedule := r.new_schedule);
    RAISE NOTICE 'cron stagger: % -> %', r.jobname, r.new_schedule;
  END LOOP;
END
$$;
