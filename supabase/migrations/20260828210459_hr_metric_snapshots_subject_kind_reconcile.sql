-- Reconciles an out-of-band schema change already applied in the SQL editor.
-- This migration is expected to be a complete no-op against the live database.

begin;
set local lock_timeout = '5s';

-- Fingerprint. RentFlow only.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='user_roles' and column_name='enabled')
  then raise exception 'Wrong database: user_roles.enabled absent. RentFlow only.';
  end if;
end $$;

alter table public.hr_metric_snapshots
  add column if not exists subject_kind text not null default 'staff';

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid='public.hr_metric_snapshots'::regclass
                   and conname='hr_snapshot_subject_kind_ck')
  then
    alter table public.hr_metric_snapshots add constraint hr_snapshot_subject_kind_ck
      check (subject_kind in ('staff','department','org'));
  end if;
end $$;

alter table public.hr_metric_snapshots alter column staff_id      drop not null;
alter table public.hr_metric_snapshots alter column department_id drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid='public.hr_metric_snapshots'::regclass
                   and conname='hr_snapshot_subject_shape_ck')
  then
    alter table public.hr_metric_snapshots add constraint hr_snapshot_subject_shape_ck check (
         (subject_kind = 'staff'      and staff_id is not null and department_id is not null)
      or (subject_kind = 'department' and staff_id is null     and department_id is not null)
      or (subject_kind = 'org'        and staff_id is null     and department_id is null)
    );
  end if;
end $$;

-- NULLs are DISTINCT in a unique index, so the old index stops preventing
-- duplicates once staff_id is nullable. One partial index per kind.
drop index if exists public.hr_snapshot_unique;

create unique index if not exists hr_snapshot_unique_staff on public.hr_metric_snapshots
  (staff_id, metric_key, period_start, period_end, metric_version) where subject_kind = 'staff';

create unique index if not exists hr_snapshot_unique_department on public.hr_metric_snapshots
  (department_id, metric_key, period_start, period_end, metric_version) where subject_kind = 'department';

create unique index if not exists hr_snapshot_unique_org on public.hr_metric_snapshots
  (metric_key, period_start, period_end, metric_version) where subject_kind = 'org';

create index if not exists hr_snapshot_department on public.hr_metric_snapshots
  (department_id, period_start) where subject_kind = 'department';

commit;
