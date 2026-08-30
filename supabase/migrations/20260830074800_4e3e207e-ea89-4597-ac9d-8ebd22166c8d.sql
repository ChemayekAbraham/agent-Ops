do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_roles' and column_name = 'enabled'
  ) then
    raise exception 'Wrong database: user_roles.enabled absent. This migration is for RentFlow only.';
  end if;
end $$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'hr-metric-snapshots-daily') then
    perform cron.unschedule('hr-metric-snapshots-daily');
  end if;
end $$;

select cron.schedule(
  'hr-metric-snapshots-daily',
  '45 2 * * *',
  $job$
  select public.hr_compute_snapshots(
    date_trunc('month', (now() at time zone 'Africa/Kampala'))::date,
    (date_trunc('month', (now() at time zone 'Africa/Kampala')) + interval '1 month' - interval '1 day')::date
  );
  $job$
);