create table if not exists public.engrep_unclaimed_objects (
  id uuid primary key default gen_random_uuid(),
  window_id uuid not null references public.engrep_windows(id),
  object_kind text not null,
  object_key text not null,
  change text not null,
  detected_at timestamptz not null default now(),
  investigated_at timestamptz,
  investigated_by uuid,
  note text,
  constraint engrep_unclaimed_change check (change in ('added','removed','changed')),
  constraint engrep_unclaimed_note check (investigated_at is null or char_length(btrim(coalesce(note,''))) >= 25)
);
create unique index if not exists engrep_unclaimed_uk
  on public.engrep_unclaimed_objects (window_id, object_kind, object_key);

grant select, update on public.engrep_unclaimed_objects to authenticated;
grant all on public.engrep_unclaimed_objects to service_role;

create or replace view public.engrep_claimed_not_live
with (security_invoker = true) as
  select r.id as row_id, r.window_id, r.source, r.engineer_code, r.author_email,
         r.evidence_kind, r.evidence_ref, r.commit_subject, r.change_classes,
         r.migration_bearing, r.zero_reason
  from public.engrep_rows r
  where r.claims_schema and r.live_verified = 'no';

create or replace function public.engrep_detect_unclaimed(p_window_id uuid)
returns integer language plpgsql security definer
set search_path to 'public','pg_temp' as $fn$
declare v_end date; v_n integer;
begin
  if not public.engrep_is_adjudicator() then
    raise exception 'engrep: only the adjudicator may run detection';
  end if;
  select period_end into v_end from public.engrep_windows where id = p_window_id;
  if v_end is null then raise exception 'engrep: no such window'; end if;
  insert into public.engrep_unclaimed_objects (window_id, object_kind, object_key, change)
  select p_window_id, d.object_kind, d.object_key, d.change
  from public.engrep_catalog_delta(v_end) d
  where not exists (
    select 1 from public.engrep_rows r
    where r.window_id = p_window_id
      and r.claims_schema
      and r.live_verified = 'yes'
  )
  on conflict (window_id, object_kind, object_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $fn$;

alter table public.engrep_unclaimed_objects enable row level security;

drop policy if exists engrep_unclaimed_select on public.engrep_unclaimed_objects;
create policy engrep_unclaimed_select on public.engrep_unclaimed_objects for select
using (public.engrep_is_adjudicator() or public.has_role(auth.uid(),'cto'));

drop policy if exists engrep_unclaimed_update on public.engrep_unclaimed_objects;
create policy engrep_unclaimed_update on public.engrep_unclaimed_objects for update
using (public.engrep_is_adjudicator()) with check (public.engrep_is_adjudicator());