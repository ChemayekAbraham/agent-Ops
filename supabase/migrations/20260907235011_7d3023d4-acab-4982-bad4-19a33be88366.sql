begin;

create table if not exists public.pso_note_reversals (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.promissory_notes(id) on delete restrict,
  kind text not null check (kind in ('cancelled','duplicate','void')),
  reason text not null check (char_length(btrim(reason)) >= 10),
  reversed_by uuid not null default auth.uid(),
  reversed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists pso_note_reversals_one_per_note
  on public.pso_note_reversals (note_id);

comment on table public.pso_note_reversals is
  'A cancelled, duplicated or voided promissory note. Records the fact only: no ledger entry, no commission clawback. Whether a reversal claws back a paid commission event is an open decision for the Managing Director.';

alter table public.pso_note_reversals enable row level security;

drop policy if exists pso_note_reversals_select on public.pso_note_reversals;
create policy pso_note_reversals_select
  on public.pso_note_reversals
  for select
  to authenticated
  using (
    exists (
      select 1 from public.promissory_notes n
      where n.id = pso_note_reversals.note_id and n.agent_id = auth.uid()
    )
    or public.hr_is_admin()
    or exists (
      select 1 from public.user_roles ur
      where ur.user_id = auth.uid() and ur.enabled = true
        and ur.role = any (array['operations','cfo','coo','ceo','super_admin','manager','partner_ops','agent_ops']::app_role[])
    )
  );

drop policy if exists pso_note_reversals_insert on public.pso_note_reversals;
create policy pso_note_reversals_insert
  on public.pso_note_reversals
  for insert
  to authenticated
  with check (
    reversed_by = auth.uid()
    and exists (
      select 1 from public.user_roles ur
      where ur.user_id = auth.uid() and ur.enabled = true
        and ur.role = any (array['operations','coo','super_admin','manager','partner_ops','agent_ops']::app_role[])
    )
  );

revoke all on public.pso_note_reversals from anon;
grant select, insert on public.pso_note_reversals to authenticated;

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
  r.reversed_at                                      as reversed_at,
  r.kind                                             as reversal_kind
from public.promissory_notes n
join public.v_pso_officers o on o.user_id = n.agent_id
left join public.pso_note_reversals r on r.note_id = n.id
where (n.created_at at time zone 'Africa/Kampala')::date >= o.officer_since;

alter view public.v_pso_note_events set (security_invoker = on);
revoke all on public.v_pso_note_events from anon;
revoke insert, update, delete, truncate, references, trigger on public.v_pso_note_events from authenticated;
grant select on public.v_pso_note_events to authenticated;

comment on column public.v_pso_note_events.reversed_at is
  'Non-null when the note has been cancelled, duplicated or voided. A reversal is deducted from the day the note was created, never the day of reversal.';

drop function if exists public.pso_daily_series(date, date, uuid);

create function public.pso_daily_series(
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
  net_notes integer,
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
           count(*) filter (where v.reversed_at is not null)::int as rev_n,
           count(*) filter (where v.partner_registered)::int as reg_n
    from public.v_pso_note_events v
    group by v.staff_id, v.note_day
  )
  select sp.staff_id,
         sp.staff_ref,
         sp.day,
         coalesce(e.created_n, 0)::int,
         coalesce(e.rev_n, 0)::int,
         (coalesce(e.created_n, 0) - coalesce(e.rev_n, 0))::int,
         coalesce(e.reg_n, 0)::int
  from spine sp
  left join ev e on e.ev_staff_id = sp.staff_id and e.ev_day = sp.day
  order by sp.staff_ref, sp.day;
end;
$function$;

revoke all on function public.pso_daily_series(date, date, uuid) from public, anon;
grant execute on function public.pso_daily_series(date, date, uuid) to authenticated;

commit;