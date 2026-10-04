begin;

create or replace function public.pso_cohort_volume(
  p_from date,
  p_to date
)
returns table (
  staff_ref text,
  days_elapsed integer,
  notes_created integer,
  notes_reversed integer,
  net_notes integer,
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
    select o.staff_id, o.staff_ref, o.officer_since
    from public.v_pso_officers o
  ),
  spine as (
    select c.staff_id, c.staff_ref, d::date as day
    from cohort c
    cross join lateral generate_series(
      greatest(p_from, c.officer_since)::timestamp,
      least(p_to, (now() at time zone 'Africa/Kampala')::date)::timestamp,
      interval '1 day'
    ) as d
  ),
  ev as (
    select v.staff_id as ev_staff_id,
           v.note_day as ev_day,
           count(*)::int as created_n,
           count(*) filter (where v.reversed_at is not null)::int as rev_n
    from public.v_pso_note_events v
    group by v.staff_id, v.note_day
  )
  select sp.staff_ref,
         count(*)::int,
         coalesce(sum(e.created_n), 0)::int,
         coalesce(sum(e.rev_n), 0)::int,
         (coalesce(sum(e.created_n), 0) - coalesce(sum(e.rev_n), 0))::int,
         bool_or(sp.staff_id = v_self)
  from spine sp
  left join ev e on e.ev_staff_id = sp.staff_id and e.ev_day = sp.day
  group by sp.staff_ref
  order by sp.staff_ref;
end;
$function$;

comment on function public.pso_cohort_volume(date, date) is
  'Cohort note volume visible to every enrolled Platform Sales Officer and to the reviewer chain. Officers are identified by staff code only: no name, no money, no commission, no rank and no band are returned, by design. Rows are ordered by staff code, which is not a ranking.';

revoke all on function public.pso_cohort_volume(date, date) from public, anon;
grant execute on function public.pso_cohort_volume(date, date) to authenticated;

commit;
