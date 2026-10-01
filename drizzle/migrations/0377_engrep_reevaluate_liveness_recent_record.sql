create or replace function public.engrep_reevaluate_liveness_recent(p_days integer default 7)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_today date := (now() at time zone 'Africa/Kampala')::date;
  v_total integer := 0;
  v_win record;
begin
  if p_days is null or p_days < 1 or p_days > 31 then
    raise exception 'engrep: p_days must be between 1 and 31';
  end if;
  for v_win in
    select w.period_start
      from public.engrep_windows w
     where w.granularity = 'day'
       and w.locked_at is null
       and w.period_start >= v_today - p_days
       and w.period_start <= v_today
     order by w.period_start
  loop
    v_total := v_total + public.engrep_reevaluate_liveness(v_win.period_start);
  end loop;
  return v_total;
end $$;

revoke all on function public.engrep_reevaluate_liveness_recent(integer) from public, anon, authenticated;
grant execute on function public.engrep_reevaluate_liveness_recent(integer) to service_role;

do $$
begin
  if (select command from cron.job where jobid = 40897) is distinct from 'select public.engrep_reevaluate_liveness_recent(7);' then
    perform cron.alter_job(job_id := 40897, command := 'select public.engrep_reevaluate_liveness_recent(7);');
  end if;
end $$;