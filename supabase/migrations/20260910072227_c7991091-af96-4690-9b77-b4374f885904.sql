create table public.engrep_adjudicators (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references public.hr_staff(id),
  started_on  date not null default (now() at time zone 'Africa/Kampala')::date,
  ended_on    date,
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid
);

create unique index engrep_adjudicators_one_active
  on public.engrep_adjudicators (staff_id) where ended_on is null;

grant select, insert, update on public.engrep_adjudicators to authenticated;
grant all on public.engrep_adjudicators to service_role;

alter table public.engrep_adjudicators enable row level security;

create policy "engrep_adjudicators_select" on public.engrep_adjudicators
  for select to authenticated
  using (
    public.has_role(auth.uid(),'super_admin')
    or public.has_role(auth.uid(),'ceo')
    or public.has_role(auth.uid(),'cto')
    or staff_id = public.hr_my_staff_id()
  );

create policy "engrep_adjudicators_insert" on public.engrep_adjudicators
  for insert to authenticated
  with check ( public.has_role(auth.uid(),'super_admin') );

create policy "engrep_adjudicators_update" on public.engrep_adjudicators
  for update to authenticated
  using ( public.has_role(auth.uid(),'super_admin') )
  with check ( public.has_role(auth.uid(),'super_admin') );

insert into public.engrep_adjudicators (staff_id, note)
values ('5ae6976d-b96b-42ba-8c5d-55ec4099e999',
        'Managing Director, EMP-00002. Adjudicator of record from first ENGREP window.');

CREATE OR REPLACE FUNCTION public.engrep_is_adjudicator()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select public.has_role(auth.uid(),'super_admin')
      or exists (
           select 1 from public.engrep_adjudicators a
           where a.staff_id = public.hr_my_staff_id()
             and a.ended_on is null )
$function$;