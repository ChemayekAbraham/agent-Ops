create or replace function public.engrep_is_adjudicator()
returns boolean language sql stable security definer
set search_path to 'public','pg_temp' as $fn$
  select public.has_role(auth.uid(),'super_admin')
      or exists (
        select 1
        from public.hr_assignments a
        join public.hr_positions p on p.id = a.position_id
        where a.staff_id = public.hr_my_staff_id()
          and p.key = 'lead_engineer'
          and a.ended_on is null
      )
$fn$;

create table if not exists public.engrep_engineers (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  staff_id uuid not null references public.hr_staff(id),
  git_emails text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  constraint engrep_engineers_code_fmt check (code = upper(code) and code ~ '^[A-Z]{2,4}$')
);
create unique index if not exists engrep_engineers_code_key on public.engrep_engineers (code);
create unique index if not exists engrep_engineers_staff_key on public.engrep_engineers (staff_id);

create table if not exists public.engrep_windows (
  id uuid primary key default gen_random_uuid(),
  granularity text not null,
  period_start date not null,
  period_end date not null,
  opened_at timestamptz not null default now(),
  harvested_at timestamptz,
  status text not null default 'open',
  locked_at timestamptz,
  locked_by uuid,
  constraint engrep_windows_gran check (granularity in ('day','week','month')),
  constraint engrep_windows_status check (status in ('open','locked')),
  constraint engrep_windows_order check (period_end >= period_start),
  constraint engrep_windows_lock_pair
    check (status = 'open' or (locked_at is not null and locked_by is not null))
);
create unique index if not exists engrep_windows_period_key
  on public.engrep_windows (granularity, period_start);

grant select, insert, update on public.engrep_engineers to authenticated;
grant all on public.engrep_engineers to service_role;
grant select on public.engrep_windows to authenticated;
grant all on public.engrep_windows to service_role;

alter table public.engrep_engineers enable row level security;
alter table public.engrep_windows   enable row level security;

drop policy if exists engrep_engineers_select on public.engrep_engineers;
create policy engrep_engineers_select on public.engrep_engineers for select
using (
  public.engrep_is_adjudicator()
  or staff_id = public.hr_my_staff_id()
  or public.has_role(auth.uid(),'cto')
  or public.has_role(auth.uid(),'ceo')
);

drop policy if exists engrep_engineers_insert on public.engrep_engineers;
create policy engrep_engineers_insert on public.engrep_engineers for insert
with check (public.engrep_is_adjudicator());

drop policy if exists engrep_engineers_update on public.engrep_engineers;
create policy engrep_engineers_update on public.engrep_engineers for update
using (public.engrep_is_adjudicator()) with check (public.engrep_is_adjudicator());

drop policy if exists engrep_windows_select on public.engrep_windows;
create policy engrep_windows_select on public.engrep_windows for select
using (
  public.engrep_is_adjudicator()
  or public.hr_is_engineering()
  or public.has_role(auth.uid(),'cto')
  or public.has_role(auth.uid(),'ceo')
);