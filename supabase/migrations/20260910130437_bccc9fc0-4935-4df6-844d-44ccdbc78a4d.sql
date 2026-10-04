create table public.engrep_harvest_runs (
  id           uuid primary key default gen_random_uuid(),
  zone         text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  window_id    uuid references public.engrep_windows(id),
  outcome      text,
  stats        jsonb,
  error        text,
  constraint engrep_run_zone check (zone in ('external_commit','lovable_edit')),
  constraint engrep_run_outcome check (outcome is null or outcome in ('ok','partial','failed'))
);

create index engrep_harvest_runs_started on public.engrep_harvest_runs (started_at desc);

grant select on public.engrep_harvest_runs to authenticated;
grant all on public.engrep_harvest_runs to service_role;

alter table public.engrep_harvest_runs enable row level security;

create policy "engrep harvest runs readable by adjudicators and cto"
on public.engrep_harvest_runs
for select
to authenticated
using ( public.engrep_is_adjudicator() or public.has_role(auth.uid(),'cto') );

create or replace function public.engrep_svc_run_start(p_zone text)
returns uuid
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_id uuid;
begin
  insert into public.engrep_harvest_runs (zone)
  values (p_zone)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.engrep_svc_run_finish(
  p_run_id uuid,
  p_window_id uuid,
  p_outcome text,
  p_stats jsonb,
  p_error text
)
returns void
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
begin
  update public.engrep_harvest_runs
     set finished_at = now(),
         window_id = p_window_id,
         outcome = p_outcome,
         stats = p_stats,
         error = p_error
   where id = p_run_id;
  if not found then
    raise exception 'engrep_svc_run_finish: no harvest run %', p_run_id;
  end if;
end;
$$;

revoke all on function public.engrep_svc_run_start(text) from public, anon, authenticated;
grant execute on function public.engrep_svc_run_start(text) to service_role;

revoke all on function public.engrep_svc_run_finish(uuid, uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.engrep_svc_run_finish(uuid, uuid, text, jsonb, text) to service_role;