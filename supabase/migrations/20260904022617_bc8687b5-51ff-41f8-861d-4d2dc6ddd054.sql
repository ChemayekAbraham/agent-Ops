create or replace view public.v_rent_plan_schedule
with (security_invoker = on) as
with pay as (
  select rent_request_id, max((created_at at time zone 'Africa/Kampala')::date) as last_pay_date
  from (
    select rent_request_id, created_at from public.agent_collections where rent_request_id is not null
    union all
    select rent_request_id, created_at from public.repayments        where rent_request_id is not null
  ) x
  group by 1
)
select
  rr.id                                     as rent_request_id,
  rr.agent_id,
  rr.tenant_id,
  coalesce(rr.daily_repayment, 0)::numeric  as daily_amount,
  coalesce(rr.total_repayment, 0)::numeric  as total_amount,
  coalesce(rr.amount_repaid, 0)::numeric    as amount_repaid,
  s.term_start,
  s.term_end,
  coalesce(rr.duration_days, 0)::int        as term_days,
  o.obligation_end,
  ((o.obligation_end - s.term_start) + 1)::int as oblig_days,
  (rr.status in ('funded','repaying')
     and coalesce(rr.total_repayment,0) - coalesce(rr.amount_repaid,0) > 0) as is_live
from public.rent_requests rr
left join pay on pay.rent_request_id = rr.id
cross join lateral (
  select
    (coalesce(rr.funded_at, rr.disbursed_at, rr.created_at) at time zone 'Africa/Kampala')::date as term_start,
    ((coalesce(rr.funded_at, rr.disbursed_at, rr.created_at) at time zone 'Africa/Kampala')::date
      + coalesce(rr.duration_days,0) - 1)::date as term_end
) s
cross join lateral (
  select case
    when coalesce(rr.total_repayment,0) - coalesce(rr.amount_repaid,0) > 0 then s.term_end
    else least(s.term_end, coalesce(pay.last_pay_date, s.term_end))
  end as obligation_end
) o
where s.term_start is not null
  and rr.status in ('funded','repaying','completed')
  and coalesce(rr.agent_payment_status,'paying') <> 'not_paying'
  and rr.tenancy_status = 'active'
  and rr.tenancy_ended_at is null
  and coalesce(rr.duration_days,0) > 0
  and not exists (
    select 1 from public.rent_repayment_pauses pz
    where pz.rent_request_id = rr.id
      and pz.status = 'active'
      and pz.resumed_at is null
  );

comment on view public.v_rent_plan_schedule is
  'Canonical repayment schedule cohort. term_end is the contractual end; obligation_end stops at the settlement date for plans already paid off, so historical days keep the plans that were genuinely due then. is_live marks plans still owing today. Expected and defaulted figures must derive from this view only.';

revoke all on public.v_rent_plan_schedule from anon;

CREATE OR REPLACE FUNCTION public.get_agent_collections_command_center(p_start timestamp with time zone, p_end timestamp with time zone, p_bucket text DEFAULT 'day'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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

  -- Expected across the range: contractual instalments falling inside each plan's term window.
  select coalesce(sum(
      least(s.daily_amount * greatest(least(v_d2 - s.term_start + 1, s.oblig_days), 0), s.total_amount)
    - least(s.daily_amount * greatest(least(v_d1 - s.term_start,     s.oblig_days), 0), s.total_amount)
  ), 0)
  into v_expected
  from public.v_rent_plan_schedule s;

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
    with days as (select generate_series(v_d1, v_d2, interval '1 day')::date as d)
    select coalesce(jsonb_agg(jsonb_build_object(
      'day', to_char(x.d, 'YYYY-MM-DD'),
      'expected_ugx', x.amt,
      'plans', x.plans,
      'elapsed', (x.d <= v_today)
    ) order by x.d), '[]'::jsonb)
    into v_expected_daily
    from (
      select dy.d,
        coalesce(sum(
            least(s.daily_amount * (dy.d - s.term_start + 1), s.total_amount)
          - least(s.daily_amount * (dy.d - s.term_start),     s.total_amount)
        ), 0) as amt,
        count(s.rent_request_id) as plans
      from days dy
      left join public.v_rent_plan_schedule s
        on s.term_start <= dy.d and s.obligation_end >= dy.d
      group by dy.d
    ) x;
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

  -- Per-agent collected vs expected, on the same schedule basis as the tile.
  with col as (
    select ac.agent_id, sum(ac.amount) as amt, count(*) as cnt,
           count(distinct ac.tenant_id) as tenants, max(ac.created_at) as last_at
    from agent_collections ac
    where ac.created_at >= v_start and ac.created_at < v_end and ac.amount > 0
    group by 1
  ),
  exp_agent as (
    select s.agent_id,
      sum(
          least(s.daily_amount * greatest(least(v_d2 - s.term_start + 1, s.oblig_days), 0), s.total_amount)
        - least(s.daily_amount * greatest(least(v_d1 - s.term_start,     s.oblig_days), 0), s.total_amount)
      ) as expected,
      sum(
          least(s.daily_amount * greatest(least(v_asof - s.term_start + 1, s.oblig_days), 0), s.total_amount)
        - least(s.daily_amount * greatest(least(v_asof - s.term_start,     s.oblig_days), 0), s.total_amount)
      ) as expected_daily,
      count(*) as active_count
    from public.v_rent_plan_schedule s
    where s.term_start <= v_d2 and s.obligation_end >= v_d1
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
    'expected_source', 'schedule',
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