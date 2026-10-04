UPDATE public.hr_metric_definitions
SET target_value = NULL, amber_at = NULL, red_at = NULL
WHERE key LIKE 'cc\_%';

GRANT EXECUTE ON FUNCTION public.hr_compute_cc_snapshots(date, date) TO postgres;
REVOKE EXECUTE ON FUNCTION public.hr_compute_cc_snapshots(date, date) FROM PUBLIC, anon, authenticated;

SELECT cron.schedule(
  'cc-metric-snapshots-daily',
  '50 2 * * *',
  $job$
  select public.hr_compute_cc_snapshots(
    date_trunc('month', (now() at time zone 'Africa/Kampala'))::date,
    (date_trunc('month', (now() at time zone 'Africa/Kampala')) + interval '1 month' - interval '1 day')::date
  );
  $job$
);