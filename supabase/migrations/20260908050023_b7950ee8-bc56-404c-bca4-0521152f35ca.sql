create or replace function public.get_ceo_growth_quality(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_days integer := greatest(1, least(coalesce(p_days, 30), 180));
  v_from timestamptz := now() - (v_days || ' days')::interval;
  v_today date := (now() at time zone 'Africa/Kampala')::date;
  v_yday date := v_today - 1;
  v_signals_today bigint := 0;
  v_signals_yday bigint := 0;
  v_signals_window bigint := 0;
  v_distinct_actors bigint := 0;
  v_trust_users bigint := 0;
  v_total_users bigint := 0;
  v_verified_users bigint := 0;
  v_gps_today bigint := 0;
  v_cities_window bigint := 0;
  v_cities_all bigint := 0;
  v_capital_window numeric := 0;
  v_repaid_window numeric := 0;
  v_book_outstanding numeric := 0;
  v_arrears numeric := 0;
  v_funded_active bigint := 0;
  v_funded_window bigint := 0;
  v_revenue_window numeric := 0;
  v_avg_trust numeric := 0;
  v_bands jsonb := '[]'::jsonb;
  v_median_fund_hours numeric := 0;
  v_queue_count bigint := 0;
  v_queue_oldest_hours numeric := 0;
  v_expected_today numeric := 0;
  v_collected_today numeric := 0;
  v_collecting_agents bigint := 0;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if not (
    public.has_role(v_uid, 'ceo') or public.has_role(v_uid, 'manager')
    or public.has_role(v_uid, 'super_admin') or public.has_role(v_uid, 'cfo')
    or public.has_role(v_uid, 'coo')
  ) then
    raise exception 'not authorized';
  end if;

  select
    count(*) filter (where (created_at at time zone 'Africa/Kampala')::date = v_today),
    count(*) filter (where (created_at at time zone 'Africa/Kampala')::date = v_yday),
    count(*) filter (where created_at >= v_from),
    count(distinct coalesce(actor_id, user_id)) filter (where created_at >= v_from)
  into v_signals_today, v_signals_yday, v_signals_window, v_distinct_actors
  from public.system_events
  where created_at >= least(v_from, v_yday::timestamptz);

  select count(*) into v_trust_users from public.welile_trust_score_cache;
  select count(*), count(*) filter (where verified) into v_total_users, v_verified_users from public.profiles;

  select
    (select count(*) from public.agent_visits where (coalesce(checked_in_at, created_at) at time zone 'Africa/Kampala')::date = v_today)
    + (select count(*) from public.venue_visits where (coalesce(visited_at, created_at) at time zone 'Africa/Kampala')::date = v_today)
  into v_gps_today;

  select count(distinct lower(btrim(request_city))) into v_cities_window
  from public.rent_requests
  where created_at >= v_from and coalesce(btrim(request_city), '') <> '';

  select count(distinct lower(btrim(request_city))) into v_cities_all
  from public.rent_requests
  where coalesce(btrim(request_city), '') <> '';

  select
    coalesce(sum(rent_amount) filter (where funded_at >= v_from), 0),
    count(*) filter (where funded_at >= v_from),
    count(*) filter (where status in ('funded','disbursed','repaying'))
  into v_capital_window, v_funded_window, v_funded_active
  from public.rent_requests;

  select coalesce(sum(amount), 0) into v_repaid_window
  from public.agent_collections where created_at >= v_from;

  with book as (
    select r.id, r.tenant_id,
           greatest(coalesce(r.total_repayment, 0) - coalesce(r.amount_repaid, 0), 0) as outstanding,
           coalesce(r.daily_repayment, 0) as daily,
           coalesce(r.repayment_starts_on, r.funded_at::date, r.created_at::date) as starts_on,
           coalesce(r.amount_repaid, 0) as repaid
    from public.rent_requests r
    where r.status in ('funded','disbursed','repaying')
      and coalesce(r.agent_payment_status, '') <> 'not_paying'
  ), scored as (
    select b.*, greatest(0, (v_today - b.starts_on)) * b.daily as expected_to_date,
           t.score
    from book b
    left join public.welile_trust_score_cache t on t.user_id = b.tenant_id
  )
  select coalesce(sum(outstanding), 0),
         coalesce(sum(greatest(expected_to_date - repaid, 0)), 0),
         coalesce(avg(score), 0)
  into v_book_outstanding, v_arrears, v_avg_trust
  from scored;

  with book as (
    select r.id, r.tenant_id,
           coalesce(r.daily_repayment, 0) as daily,
           coalesce(r.repayment_starts_on, r.funded_at::date, r.created_at::date) as starts_on,
           coalesce(r.amount_repaid, 0) as repaid
    from public.rent_requests r
    where r.status in ('funded','disbursed','repaying')
      and coalesce(r.agent_payment_status, '') <> 'not_paying'
  ), scored as (
    select coalesce(t.tier, 'Unscored') as tier,
           greatest(0, (v_today - b.starts_on)) * b.daily as expected_to_date,
           b.repaid
    from book b
    left join public.welile_trust_score_cache t on t.user_id = b.tenant_id
  )
  select coalesce(jsonb_agg(x order by x->>'tier'), '[]'::jsonb) into v_bands
  from (
    select jsonb_build_object(
      'tier', tier,
      'plans', count(*),
      'expected', round(coalesce(sum(expected_to_date), 0)),
      'repaid', round(coalesce(sum(repaid), 0)),
      'arrears', round(coalesce(sum(greatest(expected_to_date - repaid, 0)), 0)),
      'arrears_rate', case when coalesce(sum(expected_to_date), 0) > 0
        then round(100.0 * coalesce(sum(greatest(expected_to_date - repaid, 0)), 0) / sum(expected_to_date), 1)
        else 0 end
    ) as x
    from scored group by tier
  ) s;

  select coalesce(sum(coalesce(access_fee,0)) + sum(coalesce(request_fee,0)), 0) into v_revenue_window
  from public.rent_requests where funded_at >= v_from;

  select coalesce(percentile_cont(0.5) within group (
           order by extract(epoch from (funded_at - created_at)) / 3600.0), 0)
  into v_median_fund_hours
  from public.rent_requests
  where funded_at >= v_from and funded_at is not null and created_at is not null;

  select count(*), coalesce(max(extract(epoch from (now() - created_at)) / 3600.0), 0)
  into v_queue_count, v_queue_oldest_hours
  from public.rent_requests
  where funded_at is null
    and status not in ('rejected','deleted_by_agent','fully_repaid','cancelled');

  select coalesce(sum(coalesce(daily_repayment, 0)), 0) into v_expected_today
  from public.rent_requests
  where status in ('funded','disbursed','repaying')
    and coalesce(agent_payment_status, '') <> 'not_paying'
    and greatest(coalesce(total_repayment, 0) - coalesce(amount_repaid, 0), 0) > 0;

  select coalesce(sum(amount), 0), count(distinct agent_id) into v_collected_today, v_collecting_agents
  from public.agent_collections
  where (created_at at time zone 'Africa/Kampala')::date = v_today;

  return jsonb_build_object(
    'as_at', now(),
    'window_days', v_days,
    'behavior', jsonb_build_object(
      'signals_today', v_signals_today,
      'signals_yesterday', v_signals_yday,
      'signals_window', v_signals_window,
      'signals_per_day', round(v_signals_window::numeric / v_days, 1),
      'distinct_actors', v_distinct_actors,
      'trust_scored_users', v_trust_users,
      'total_users', v_total_users,
      'trust_coverage_pct', case when v_total_users > 0 then round(100.0 * v_trust_users / v_total_users, 1) else 0 end,
      'verified_pct', case when v_total_users > 0 then round(100.0 * v_verified_users / v_total_users, 1) else 0 end,
      'gps_signals_today', v_gps_today,
      'cities_window', v_cities_window,
      'cities_all_time', v_cities_all
    ),
    'capital', jsonb_build_object(
      'capital_deployed', round(v_capital_window),
      'plans_funded', v_funded_window,
      'plans_active', v_funded_active,
      'collected_window', round(v_repaid_window),
      'book_outstanding', round(v_book_outstanding),
      'arrears', round(v_arrears),
      'arrears_rate', case when v_book_outstanding > 0 then round(100.0 * v_arrears / v_book_outstanding, 1) else 0 end,
      'fees_window', round(v_revenue_window),
      'fee_yield_pct', case when v_capital_window > 0 then round(100.0 * v_revenue_window / v_capital_window, 1) else 0 end,
      'capital_per_plan', case when v_funded_window > 0 then round(v_capital_window / v_funded_window) else 0 end,
      'avg_trust_score', round(v_avg_trust, 1),
      'bands', v_bands
    ),
    'tempo', jsonb_build_object(
      'median_fund_hours', round(v_median_fund_hours, 1),
      'queue_count', v_queue_count,
      'queue_oldest_hours', round(v_queue_oldest_hours, 1),
      'expected_today', round(v_expected_today),
      'collected_today', round(v_collected_today),
      'collection_rate_today', case when v_expected_today > 0 then round(100.0 * v_collected_today / v_expected_today, 1) else 0 end,
      'collecting_agents_today', v_collecting_agents
    )
  );
end;
$$;

revoke all on function public.get_ceo_growth_quality(integer) from public;
grant execute on function public.get_ceo_growth_quality(integer) to authenticated;