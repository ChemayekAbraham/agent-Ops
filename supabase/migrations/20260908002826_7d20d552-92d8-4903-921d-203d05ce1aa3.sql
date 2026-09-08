begin;

create or replace function public.pso_is_officer()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from public.v_pso_officers o
    where o.staff_id = public.hr_my_staff_id()
  );
$function$;

comment on function public.pso_is_officer() is
  'True when the caller is enrolled staff currently holding the Platform Sales Officer position. Used to decide whether the My performance entry appears in a person''s own workspace menu.';

revoke all on function public.pso_is_officer() from public, anon;
grant execute on function public.pso_is_officer() to authenticated;

drop function if exists public.pso_cohort_volume(date, date);

create function public.pso_cohort_volume(
  p_from date,
  p_to date
)
returns table (
  staff_ref text,
  mon integer,
  tue integer,
  wed integer,
  thu integer,
  fri integer,
  sat integer,
  sun integer,
  total_net integer,
  is_me boolean
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_self uuid := public.hr_my_staff_id();
  v_is_officer boolean;
  v_reviewer boolean;
begin
  v_is_officer := v_self is not null and exists (
    select 1 from public.v_pso_officers o where o.staff_id = v_self
  );
  v_reviewer := public.hr_is_admin()
    or public.hr_is_executive()
    or exists (
      select 1
      from public.user_roles ur
      where ur.user_id = auth.uid()
        and ur.enabled = true
        and ur.role = any (array['coo'::app_role, 'ceo'::app_role, 'super_admin'::app_role])
    );

  if not (v_is_officer or v_reviewer) then
    raise exception 'pso_cohort_volume: not permitted';
  end if;

  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'pso_cohort_volume: invalid window';
  end if;
  if (p_to - p_from) > 366 then
    raise exception 'pso_cohort_volume: window exceeds 366 days';
  end if;

  return query
  with cohort as (
    select o.staff_id, o.staff_ref
    from public.v_pso_officers o
  ),
  ev as (
    select v.staff_id as ev_staff_id,
           v.note_day as ev_day,
           (count(*) - count(*) filter (where v.reversed_at is not null))::int as net_n
    from public.v_pso_note_events v
    where v.note_day between p_from and p_to
    group by v.staff_id, v.note_day
  )
  select c.staff_ref,
         coalesce(sum(e.net_n) filter (where extract(isodow from e.ev_day) = 1), 0)::int,
         coalesce(sum(e.net_n) filter (where extract(isodow from e.ev_day) = 2), 0)::int,
         coalesce(sum(e.net_n) filter (where extract(isodow from e.ev_day) = 3), 0)::int,
         coalesce(sum(e.net_n) filter (where extract(isodow from e.ev_day) = 4), 0)::int,
         coalesce(sum(e.net_n) filter (where extract(isodow from e.ev_day) = 5), 0)::int,
         coalesce(sum(e.net_n) filter (where extract(isodow from e.ev_day) = 6), 0)::int,
         coalesce(sum(e.net_n) filter (where extract(isodow from e.ev_day) = 7), 0)::int,
         coalesce(sum(e.net_n), 0)::int as total_net,
         bool_or(c.staff_id is not distinct from v_self)
  from cohort c
  left join ev e on e.ev_staff_id = c.staff_id
  group by c.staff_ref
  order by coalesce(sum(e.net_n), 0) desc, c.staff_ref;
end;
$function$;

comment on function public.pso_cohort_volume(date, date) is
  'Cohort promissory-note volume by weekday, ordered by total net notes descending. Visible to enrolled Platform Sales Officers and the reviewer chain only. Officers are identified by staff code: no name, no money, no commission and no band are returned, by design. The descending order is a deliberate ranking and is pending a written decision by the Managing Director recorded against the Guardrails decision log.';

revoke all on function public.pso_cohort_volume(date, date) from public, anon;
grant execute on function public.pso_cohort_volume(date, date) to authenticated;

commit;