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

-- Normalise the seed units to the vocabulary the screens and the admin form
-- already use. Display only: no threshold, direction or value is touched.
update public.hr_metric_definitions set unit = 'percent' where unit = '%';
update public.hr_metric_definitions set unit = 'count'   where unit = 'tasks';

-- One table owns the question. Added after the updates so it validates clean.
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid='public.hr_metric_definitions'::regclass
                   and conname='hr_metric_definitions_unit_ck')
  then
    alter table public.hr_metric_definitions add constraint hr_metric_definitions_unit_ck
      check (unit in ('count','percent','currency_ugx','hours','days','ratio'));
  end if;
end $$;

commit;
