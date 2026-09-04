create table if not exists public.agent_expected_day_plans (
  day date not null,
  rent_request_id uuid not null,
  agent_id uuid,
  tenant_id uuid,
  expected_ugx numeric not null default 0,
  captured_at timestamptz not null default now(),
  primary key (day, rent_request_id)
);

grant select on public.agent_expected_day_plans to authenticated;
grant all on public.agent_expected_day_plans to service_role;

alter table public.agent_expected_day_plans enable row level security;

drop policy if exists "ops can read expected day plans" on public.agent_expected_day_plans;
create policy "ops can read expected day plans"
on public.agent_expected_day_plans for select to authenticated
using (
  has_role(auth.uid(), 'manager') or has_role(auth.uid(), 'super_admin')
  or has_role(auth.uid(), 'ceo') or has_role(auth.uid(), 'coo')
  or has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'operations')
  or has_role(auth.uid(), 'agent_ops')
);

create index if not exists idx_agent_expected_day_plans_day on public.agent_expected_day_plans(day);
create index if not exists idx_agent_expected_day_plans_agent on public.agent_expected_day_plans(agent_id, day);

-- Pin (freeze) the expected schedule for a day. First call for a day wins; later calls are no-ops,
-- so intraday settlements / new fundings can never move a day's expected figure.
create or replace function public.pin_agent_expected_day(p_day date)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_rows int := 0;
begin
  if p_day is null or p_day > (now() at time zone 'Africa/Kampala')::date then
    return 0;
  end if;

  if exists (select 1 from public.agent_expected_day_plans where day = p_day) then
    return 0;
  end if;

  insert into public.agent_expected_day_plans (day, rent_request_id, agent_id, tenant_id, expected_ugx)
  select p_day, s.rent_request_id, s.agent_id, s.tenant_id,
         least(s.daily_amount * (p_day - s.term_start + 1), s.total_amount)
       - least(s.daily_amount * (p_day - s.term_start),     s.total_amount)
  from public.v_rent_plan_schedule s
  where s.term_start <= p_day and s.obligation_end >= p_day
  on conflict (day, rent_request_id) do nothing;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.pin_agent_expected_day(date) from public;
grant execute on function public.pin_agent_expected_day(date) to service_role;

CREATE OR REPLACE FUNCTION public.get_agent_collections_command_center(p_start timestamp with time zone, p_end timestamp with time zone, p_bucket text DEFAULT 'day'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_bucket text := lower(coalesce(p_bucket, 'day'));
  v_start timestamptz := p_start;
  v_end timestamptz := p_end;
  v_days numeric;
  v_d1 date; v_d2 date; v_today date; v_asof date; v_span int;
  v_totals jsonb; v_series jsonb; v_hours jsonb; v_agents jsonb; v_expected_daily jsonb;
  v_expected numeric := 0;
  v_defaulted numeric := 0;
  v_defaulted_plans int := 0;
begin
  if not (
    has_role(auth.uid(), 'manager') or has_role(auth.uid(), 'super_admin')
    or has_role(auth.uid(), 'ceo') or has_role(auth.uid(), 'coo')
    or has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'operations')
    or has_role(auth.uid(), 'agent_ops')
  ) then
    raise exception 'not authorized';
  end if;

  if v_start is null or v_end is null or v_end <= v_start then
    raise exception 'invalid range';
  end if;

  if v_bucket not in ('hour','day','week','month') then
    v_bucket := 'day';
  end if;

  v_days  := greatest(1, ceil(extract(epoch from (v_end - v_start)) / 86400.0));
  v_today := (now() at time zone 'Africa/Kampala')::date;
  v_d1    := (v_start at time zone 'Africa/Kampala')::date;
  v_d2    := ((v_end - interval '1 microsecond') at time zone 'Africa/Kampala')::date;
  v_asof  := least(v_d2, v_today);
  v_span  := (v_d2 - v_d1) + 1;

  -- Freeze (pin) each elapsed day's expected cohort, then read expected strictly from the pins.
  -- The first read of a day writes the pin; every later read returns the same fixed figure.
  perform public.pin_agent_expected_day(g.d::date)
  from generate_series(v_d1, v_asof, interval '1 day') g(d);

  select coalesce(sum(x.amt), 0) into v_expected
  from (
    select sum(p.expected_ugx) as amt
    from public.agent_expected_day_plans p
    where p.day between v_d1 and least(v_d2, v_today)
    union all
    select coalesce(sum(
        least(s.daily_amount * (dy.d - s.term_start + 1), s.total_amount)
      - least(s.daily_amount * (dy.d - s.term_start),     s.total_amount)
    ), 0)
    from generate_series(greatest(v_d1, v_today + 1), v_d2, interval '1 day') dy(d)
    join public.v_rent_plan_schedule s
      on s.term_start <= dy.d::date and s.obligation_end >= dy.d::date
  ) x;

  -- Defaulted as at the range end (never past today): scheduled-to-date minus paid-to-date.
  with due as (
    select s.rent_request_id, s.amount_repaid,
      least(s.daily_amount * greatest(least(v_asof - s.term_start + 1, s.oblig_days), 0), s.total_amount) as scheduled_to_date
    from public.v_rent_plan_schedule s
  ), later as (
    select ac.rent_request_id, sum(ac.amount) as amt
    from public.agent_collections ac
    where ac.rent_request_id is not null
      and (ac.created_at at time zone 'Africa/Kampala')::date > v_asof
    group by 1
  ), sh as (
    select greatest(0, d.scheduled_to_date - greatest(0, d.amount_repaid - coalesce(l.amt, 0))) as shortfall
    from due d
    left join later l on l.rent_request_id = d.rent_request_id
  )
  select coalesce(sum(shortfall), 0), count(*) filter (where shortfall > 0)
  into v_defaulted, v_defaulted_plans
  from sh;

  -- Totals
  select jsonb_build_object(
    'collected', coalesce(c.amt, 0),
    'collections_count', coalesce(c.cnt, 0),
    'active_agents', coalesce(c.agents, 0),
    'tenants_paid', coalesce(c.tenants, 0),
    'avg_collection', case when coalesce(c.cnt,0) > 0 then round(coalesce(c.amt,0) / c.cnt) else 0 end,
    'requests_count', coalesce(r.cnt, 0),
    'requests_amount', coalesce(r.amt, 0),
    'days', v_days,
    'expected_due', v_expected,
    'expected_basis', 'pinned_schedule',
    'defaulted_to_date', v_defaulted,
    'defaulted_plans', v_defaulted_plans,
    'defaulted_as_of', to_char(v_asof, 'YYYY-MM-DD'),
    'span_days', v_span
  )
  into v_totals
  from (
    select sum(ac.amount) as amt, count(*) as cnt,
           count(distinct ac.agent_id) as agents, count(distinct ac.tenant_id) as tenants
    from agent_collections ac
    where ac.created_at >= v_start and ac.created_at < v_end and ac.amount > 0
  ) c
  cross join (
    select count(*) as cnt, sum(rr.rent_amount) as amt
    from rent_requests rr
    where rr.created_at >= v_start and rr.created_at < v_end
      and coalesce(rr.status,'') not in ('deleted_by_agent','rejected')
  ) r;

  -- Per-day expected across the range (guarded: only for spans of 92 days or less).
  if v_span <= 92 then
    with days as (select generate_series(v_d1, v_d2, interval '1 day')::date as d),
    pinned as (
      select p.day as d, sum(p.expected_ugx) as amt, count(*) as plans
      from public.agent_expected_day_plans p
      where p.day between v_d1 and least(v_d2, v_today)
      group by p.day
    ),
    live as (
      select dy.d,
        coalesce(sum(
            least(s.daily_amount * (dy.d - s.term_start + 1), s.total_amount)
          - least(s.daily_amount * (dy.d - s.term_start),     s.total_amount)
        ), 0) as amt,
        count(s.rent_request_id) as plans
      from days dy
      left join public.v_rent_plan_schedule s
        on s.term_start <= dy.d and s.obligation_end >= dy.d
      where dy.d > v_today
      group by dy.d
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'day', to_char(dy.d, 'YYYY-MM-DD'),
      'expected_ugx', coalesce(pn.amt, lv.amt, 0),
      'plans', coalesce(pn.plans, lv.plans, 0),
      'elapsed', (dy.d <= v_today),
      'fixed', (pn.d is not null)
    ) order by dy.d), '[]'::jsonb)
    into v_expected_daily
    from days dy
    left join pinned pn on pn.d = dy.d
    left join live lv on lv.d = dy.d;
  else
    v_expected_daily := '[]'::jsonb;
  end if;

  -- Time series (unchanged)
  with buckets as (
    select generate_series(
      date_trunc(v_bucket, v_start at time zone 'Africa/Kampala'),
      date_trunc(v_bucket, (v_end - interval '1 microsecond') at time zone 'Africa/Kampala'),
      ('1 ' || v_bucket)::interval
    ) as b
  ),
  col as (
    select date_trunc(v_bucket, ac.created_at at time zone 'Africa/Kampala') as b,
           sum(ac.amount) as amt, count(*) as cnt
    from agent_collections ac
    where ac.created_at >= v_start and ac.created_at < v_end and ac.amount > 0
    group by 1
  ),
  req as (
    select date_trunc(v_bucket, rr.created_at at time zone 'Africa/Kampala') as b,
           sum(rr.rent_amount) as amt, count(*) as cnt
    from rent_requests rr
    where rr.created_at >= v_start and rr.created_at < v_end
      and coalesce(rr.status,'') not in ('deleted_by_agent','rejected')
    group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'bucket', to_char(bk.b, case when v_bucket = 'hour' then 'YYYY-MM-DD HH24:00'
                                 when v_bucket = 'month' then 'YYYY-MM'
                                 else 'YYYY-MM-DD' end),
    'collected', coalesce(c.amt, 0),
    'collections_count', coalesce(c.cnt, 0),
    'requests_amount', coalesce(r.amt, 0),
    'requests_count', coalesce(r.cnt, 0)
  ) order by bk.b), '[]'::jsonb)
  into v_series
  from buckets bk
  left join col c on c.b = bk.b
  left join req r on r.b = bk.b;

  -- Peak hours (unchanged)
  with hrs as (select generate_series(0, 23) as h),
  agg as (
    select extract(hour from ac.created_at at time zone 'Africa/Kampala')::int as h,
           sum(ac.amount) as amt, count(*) as cnt
    from agent_collections ac
    where ac.created_at >= v_start and ac.created_at < v_end and ac.amount > 0
    group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'hour', hrs.h, 'amount', coalesce(agg.amt, 0), 'count', coalesce(agg.cnt, 0)
  ) order by hrs.h), '[]'::jsonb)
  into v_hours
  from hrs left join agg on agg.h = hrs.h;

  -- Per-agent collected vs expected, on the pinned schedule basis.
  with col as (
    select ac.agent_id, sum(ac.amount) as amt, count(*) as cnt,
           count(distinct ac.tenant_id) as tenants, max(ac.created_at) as last_at
    from agent_collections ac
    where ac.created_at >= v_start and ac.created_at < v_end and ac.amount > 0
    group by 1
  ),
  exp_agent as (
    select p.agent_id,
      sum(p.expected_ugx) as expected,
      sum(case when p.day = v_asof then p.expected_ugx else 0 end) as expected_daily,
      count(distinct p.rent_request_id) as active_count
    from public.agent_expected_day_plans p
    where p.day between v_d1 and least(v_d2, v_today)
    group by 1
  ),
  ids as (
    select agent_id from col
    union select agent_id from exp_agent
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'agent_id', i.agent_id,
    'name', coalesce(p.full_name, 'Unnamed agent'),
    'phone', p.phone,
    'avatar_url', p.avatar_url,
    'collected', coalesce(c.amt, 0),
    'collections_count', coalesce(c.cnt, 0),
    'tenants_paid', coalesce(c.tenants, 0),
    'active_tenants', coalesce(e.active_count, 0),
    'expected_daily', coalesce(e.expected_daily, 0),
    'expected', coalesce(e.expected, 0),
    'expected_source', 'pinned_schedule',
    'last_collection_at', c.last_at
  ) order by coalesce(c.amt, 0) desc), '[]'::jsonb)
  into v_agents
  from ids i
  left join col c on c.agent_id = i.agent_id
  left join exp_agent e on e.agent_id = i.agent_id
  left join profiles p on p.id = i.agent_id;

  return jsonb_build_object(
    'range', jsonb_build_object('start', v_start, 'end', v_end, 'bucket', v_bucket),
    'totals', v_totals,
    'series', v_series,
    'peak_hours', v_hours,
    'expected_daily', coalesce(v_expected_daily, '[]'::jsonb),
    'agents', v_agents,
    'generated_at', now()
  );
end;
$function$;

select cron.schedule(
  'pin-agent-expected-day-eat-midnight',
  '5 21 * * *',
  $cron$ select public.pin_agent_expected_day(((now() at time zone 'Africa/Kampala')::date)) $cron$
);