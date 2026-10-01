do $$
begin
  if (select schedule from cron.job where jobid = 20804) is distinct from '15 14 * * 3' then
    perform cron.alter_job(job_id := 20804, schedule := '15 14 * * 3');
  end if;
end $$;

select public.engrep_svc_ensure_window('week', date '2026-09-23');