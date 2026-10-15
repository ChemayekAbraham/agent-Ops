-- Doc 236: the daily/weekly CTO report cron calls never set a pg_net timeout, so
-- pg_net's 5000 ms default applied. The report build takes ~13 s (the nightly
-- get_cto_daily_report RPC alone went from ~2 s to ~8 s on 2026-10-13), so the
-- cron hung up mid-build and no e-mail was sent on 13 and 14 Oct.
--
-- Rewrites the existing job commands in place (the auth header stays in the job,
-- never in this file) to add timeout_milliseconds := 120000. Idempotent.
DO $$
DECLARE
  j record;
  new_cmd text;
BEGIN
  FOR j IN
    SELECT jobid, jobname, command FROM cron.job
     WHERE jobname IN ('daily-cto-report-tech', 'weekly-cto-report-board')
  LOOP
    IF j.command ~* 'timeout_milliseconds' THEN
      CONTINUE;
    END IF;
    new_cmd := regexp_replace(j.command, 'body\s*:=', 'timeout_milliseconds := 120000, body :=', 'i');
    IF new_cmd = j.command THEN
      RAISE EXCEPTION 'cron job % has no body argument to anchor the timeout on', j.jobname;
    END IF;
    PERFORM cron.alter_job(j.jobid, command := new_cmd);
  END LOOP;
END $$;
