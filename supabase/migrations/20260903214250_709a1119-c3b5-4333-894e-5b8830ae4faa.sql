alter table public.engrep_rows
  add column if not exists band public.hr_difficulty_band,
  add column if not exists basis text,
  add column if not exists adjudicated_by uuid,
  add column if not exists adjudicated_at timestamptz;

alter table public.engrep_rows
  drop constraint if exists engrep_rows_basis_len,
  drop constraint if exists engrep_rows_band_pair,
  drop constraint if exists engrep_rows_zero_no_band;

alter table public.engrep_rows
  add constraint engrep_rows_basis_len
    check (basis is null or char_length(btrim(basis)) >= 25),
  add constraint engrep_rows_band_pair
    check ((band is null and basis is null and adjudicated_by is null and adjudicated_at is null)
        or (band is not null and basis is not null and adjudicated_by is not null and adjudicated_at is not null)),
  add constraint engrep_rows_zero_no_band
    check (not zeroed or band is null);

create unique index if not exists engrep_rows_basis_uk
  on public.engrep_rows (window_id, lower(btrim(basis)))
  where basis is not null;

create table if not exists public.engrep_addenda (
  id uuid primary key default gen_random_uuid(),
  window_id uuid not null references public.engrep_windows(id),
  row_id uuid references public.engrep_rows(id),
  addendum_text text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint engrep_addenda_len check (char_length(btrim(addendum_text)) >= 25)
);

grant select, insert on public.engrep_addenda to authenticated;
grant all on public.engrep_addenda to service_role;

alter table public.engrep_addenda enable row level security;

drop policy if exists engrep_addenda_select on public.engrep_addenda;
create policy engrep_addenda_select on public.engrep_addenda for select
using (public.engrep_is_adjudicator()
       or public.has_role(auth.uid(),'cto')
       or public.has_role(auth.uid(),'ceo'));

drop policy if exists engrep_addenda_insert on public.engrep_addenda;
create policy engrep_addenda_insert on public.engrep_addenda for insert
with check (public.engrep_is_adjudicator() and created_by = auth.uid());

create or replace function public.engrep_guard_locked_row()
returns trigger language plpgsql
set search_path to 'public','pg_temp' as $fn$
declare v_status text;
begin
  select w.status into v_status from public.engrep_windows w
   where w.id = coalesce(new.window_id, old.window_id);
  if v_status = 'locked' then
    raise exception 'engrep: window is locked; corrections are made by dated addendum';
  end if;
  return coalesce(new, old);
end $fn$;

drop trigger if exists engrep_rows_aa_locked on public.engrep_rows;
create trigger engrep_rows_aa_locked
before insert or update or delete on public.engrep_rows
for each row execute function public.engrep_guard_locked_row();

create or replace function public.engrep_adjudicate(
  p_row_id uuid, p_band public.hr_difficulty_band, p_basis text)
returns void language plpgsql security definer
set search_path to 'public','pg_temp' as $fn$
declare v_zeroed boolean;
begin
  if not public.engrep_is_adjudicator() then
    raise exception 'engrep: only the adjudicator may set a band';
  end if;
  select zeroed into v_zeroed from public.engrep_rows where id = p_row_id;
  if v_zeroed is null then raise exception 'engrep: no such row'; end if;
  if v_zeroed then
    raise exception 'engrep: a zero cannot be overridden, only annotated by addendum';
  end if;
  update public.engrep_rows
     set band = p_band, basis = p_basis,
         adjudicated_by = auth.uid(), adjudicated_at = now()
   where id = p_row_id;
end $fn$;

create or replace function public.engrep_lock_window(p_window_id uuid)
returns integer language plpgsql security definer
set search_path to 'public','pg_temp' as $fn$
declare v_unadjudicated integer; v_status text;
begin
  if not public.engrep_is_adjudicator() then
    raise exception 'engrep: only the adjudicator may lock a period';
  end if;
  select status into v_status from public.engrep_windows where id = p_window_id;
  if v_status is null then raise exception 'engrep: no such window'; end if;
  if v_status = 'locked' then raise exception 'engrep: window already locked'; end if;
  select count(*) into v_unadjudicated from public.engrep_rows
   where window_id = p_window_id and not zeroed and (band is null or basis is null);
  if v_unadjudicated > 0 then
    raise exception 'engrep: % row(s) still need a band and a written basis', v_unadjudicated;
  end if;
  update public.engrep_windows
     set status='locked', locked_at=now(), locked_by=auth.uid()
   where id = p_window_id;
  return v_unadjudicated;
end $fn$;