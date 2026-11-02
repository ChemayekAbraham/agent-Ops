-- Pause the proxy Target Mode daily nudges (email template "proxy-daily-nudge").
-- Reversible: re-run with active := true to restore each job exactly as it was.
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'proxy-target-nudge-morning'),
  active := false
);
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'proxy-target-nudge-midday'),
  active := false
);
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'proxy-target-nudge-afternoon'),
  active := false
);