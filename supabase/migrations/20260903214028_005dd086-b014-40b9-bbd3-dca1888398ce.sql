create table if not exists public.engrep_rows (
  id uuid primary key default gen_random_uuid(),
  window_id uuid not null references public.engrep_windows(id),
  source text not null,
  engineer_code text,
  engineer_id uuid references public.engrep_engineers(id),
  author_email text,
  evidence_kind text not null,
  evidence_ref text not null,
  commit_subject text not null,
  change_classes text[] not null default '{}',
  claims_schema boolean not null default false,
  migration_bearing boolean not null default false,
  live_verified text not null default 'na',
  untagged boolean not null default false,
  fenced_breach boolean not null default false,
  fence_path text,
  self_fix boolean not null default false,
  self_fix_of uuid references public.engrep_rows(id),
  zeroed boolean not null default false,
  zero_reason text,
  harvested_at timestamptz not null default now(),
  constraint engrep_rows_source check (source in ('lovable_edit','external_commit')),
  constraint engrep_rows_ev_kind check (evidence_kind in ('message_id','sha')),
  constraint engrep_rows_ev_pair check (
    (source='lovable_edit'    and evidence_kind='message_id') or
    (source='external_commit' and evidence_kind='sha')),
  constraint engrep_rows_live check (live_verified in ('yes','no','na')),
  constraint engrep_rows_live_claim check (
    (claims_schema and live_verified in ('yes','no')) or
    (not claims_schema and live_verified='na')),
  constraint engrep_rows_classes check (
    change_classes <@ array['ddl','rls','function','trigger','edge_function','ui','config']::text[]),
  constraint engrep_rows_attrib check (
    (source='lovable_edit'    and (untagged or engineer_code is not null)) or
    (source='external_commit' and author_email is not null)),
  constraint engrep_rows_fence check (not fenced_breach or fence_path is not null),
  constraint engrep_rows_zero  check (not zeroed or zero_reason is not null),
  constraint engrep_rows_selffix check (not self_fix or self_fix_of is not null)
);
create unique index if not exists engrep_rows_evidence_uk
  on public.engrep_rows (window_id, source, evidence_ref);
create index if not exists engrep_rows_window on public.engrep_rows (window_id);
create index if not exists engrep_rows_engineer on public.engrep_rows (engineer_id);

grant select on public.engrep_rows to authenticated;
grant all on public.engrep_rows to service_role;

create or replace function public.engrep_apply_zeroing()
returns trigger language plpgsql
set search_path to 'public','pg_temp' as $fn$
begin
  if new.untagged then
    new.zeroed := true; new.zero_reason := 'untagged edit';
  elsif new.fenced_breach then
    new.zeroed := true; new.zero_reason := 'fenced breach: ' || coalesce(new.fence_path,'unspecified');
  elsif new.self_fix then
    new.zeroed := true; new.zero_reason := 'self-fix of an earlier row by the same engineer';
  elsif new.claims_schema and new.live_verified = 'no' then
    new.zeroed := true; new.zero_reason := 'claimed schema effect, absent from the catalog delta';
  else
    new.zeroed := false; new.zero_reason := null;
  end if;
  return new;
end $fn$;

drop trigger if exists engrep_rows_zeroing on public.engrep_rows;
create trigger engrep_rows_zeroing
before insert or update on public.engrep_rows
for each row execute function public.engrep_apply_zeroing();

alter table public.engrep_rows enable row level security;

drop policy if exists engrep_rows_select on public.engrep_rows;
create policy engrep_rows_select on public.engrep_rows for select
using (
  public.engrep_is_adjudicator()
  or public.has_role(auth.uid(),'cto')
  or public.has_role(auth.uid(),'ceo')
  or engineer_id in (
    select e.id from public.engrep_engineers e
    where e.staff_id = public.hr_my_staff_id()
  )
);