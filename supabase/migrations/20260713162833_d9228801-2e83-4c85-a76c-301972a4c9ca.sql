
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'landlord-daily-guarantee-sms'),
  schedule => '0 15 * * 1,5'
);
