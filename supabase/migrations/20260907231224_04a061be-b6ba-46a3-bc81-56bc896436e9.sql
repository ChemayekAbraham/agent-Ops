begin;

create or replace view public.v_pso_officers as
select
  s.id              as staff_id,
  s.user_id         as user_id,
  s.staff_ref       as staff_ref,
  min(a.started_on) as officer_since
from public.hr_staff s
join public.hr_assignments a on a.staff_id = s.id and a.ended_on is null
join public.hr_positions   p on p.id = a.position_id
where s.active
  and s.ended_on is null
  and lower(btrim(p.title)) = 'platform sales officer'
group by s.id, s.user_id, s.staff_ref;

alter view public.v_pso_officers set (security_invoker = on);
revoke all on public.v_pso_officers from anon;
grant select on public.v_pso_officers to authenticated;

create or replace view public.v_pso_note_events as
select
  n.id                                               as note_id,
  n.agent_id                                         as officer_user_id,
  o.staff_id                                         as staff_id,
  o.staff_ref                                        as staff_ref,
  o.officer_since                                    as officer_since,
  (n.created_at at time zone 'Africa/Kampala')::date as note_day,
  n.created_at                                       as created_at,
  n.amount                                           as amount,
  n.status                                           as note_status,
  (n.partner_user_id is not null)                    as partner_registered,
  null::timestamptz                                  as reversed_at
from public.promissory_notes n
join public.v_pso_officers o on o.user_id = n.agent_id
where (n.created_at at time zone 'Africa/Kampala')::date >= o.officer_since;

alter view public.v_pso_note_events set (security_invoker = on);
revoke all on public.v_pso_note_events from anon;
grant select on public.v_pso_note_events to authenticated;

comment on column public.v_pso_note_events.reversed_at is
  'Always null at v1.0. promissory_notes carries no void, cancel or duplicate status, so reversals have no source. Never render this as zero reversals.';

create or replace function public.pso_daily_series(
  p_from date,
  p_to date,
  p_staff_id uuid default null
)
returns table (
  staff_id uuid,
  staff_ref text,
  day date,
  notes_created integer,
  notes_reversed integer,
  partner_registered integer
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_self uuid := public.hr_my_staff_id();
  v_reviewer boolean := public.hr_is_admin()
    or public.hr_is_executive()
    or exists (
      select 1
      from public.user_roles ur
      where ur.user_id = auth.uid()
        and ur.enabled = true
        and ur.role = any (array['coo'::app_role, 'ceo'::app_role, 'super_admin'::app_role])
    );
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'pso_daily_series: invalid window';
  end if;
  if (p_to - p_from) > 366 then
    raise exception 'pso_daily_series: window exceeds 366 days';
  end if;
  if not v_reviewer then
    if v_self is null then
      raise exception 'pso_daily_series: not permitted';
    end if;
    if p_staff_id is not null and p_staff_id <> v_self then
      raise exception 'pso_daily_series: not permitted';
    end if;
    p_staff_id := v_self;
  end if;

  return query
  with cohort as (
    select o.staff_id, o.staff_ref, o.officer_since
    from public.v_pso_officers o
    where p_staff_id is null or o.staff_id = p_staff_id
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
           count(*) filter (where v.partner_registered)::int as reg_n
    from public.v_pso_note_events v
    group by v.staff_id, v.note_day
  )
  select sp.staff_id,
         sp.staff_ref,
         sp.day,
         coalesce(e.created_n, 0)::int,
         null::int,
         coalesce(e.reg_n, 0)::int
  from spine sp
  left join ev e on e.ev_staff_id = sp.staff_id and e.ev_day = sp.day
  order by sp.staff_ref, sp.day;
end;
$function$;

revoke all on function public.pso_daily_series(date, date, uuid) from public, anon;
grant execute on function public.pso_daily_series(date, date, uuid) to authenticated;

commit;