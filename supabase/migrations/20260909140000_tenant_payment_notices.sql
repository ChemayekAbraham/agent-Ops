-- Payment-behaviour notices (2026-09-09 tenant-ops meeting): connect tenant
-- SMS to the actual obligation state instead of letting the SMS layer
-- recompute balances. Provides the day-state primitive plus the two candidate
-- selectors the sender consumes.
--
-- Part 1 fixes a real day-attribution bug in the existing missed-day
-- functions. Part 2 adds day state (cleared / partial / unpaid). Part 3 adds
-- the selectors, each carrying the volume guards measured against production.

-- ---------------------------------------------------------------------------
-- Part 1: day-attribution fix.
--
-- get_tenant_missed_dates and get_tenant_missed_days bucket payments by
-- (created_at AT TIME ZONE 'UTC')::date, while get_tenant_repayment_reliability
-- uses 'Africa/Kampala'. Kampala is UTC+3, so a payment made between 00:00 and
-- 03:00 local lands on the PREVIOUS UTC day -- the tenant paid, but the day
-- they paid for is still counted as missed.
--
-- Measured on 2026-09-09: 84 of 8,728 collections over the trailing 90 days
-- (0.96%), touching 69 tenants, are attributed to the wrong day. Low volume,
-- but these functions now drive tenant-facing SMS and the five-day default
-- trigger, so a false missed day becomes a false accusation. Corrected to
-- Africa/Kampala, which also makes these agree with the reliability scoring.
--
-- The fix can only REMOVE false missed days, never add one, so missed-day
-- counts move slightly in the tenant's favour. Repo callers are one UI read
-- (DailyCollectionMonitoringDashboard) and the notification engine; no other
-- database function references either of these.
--
-- Day filtering also moves onto the local calendar date directly rather than
-- a timestamp range, so window edges cannot re-introduce the same skew.

create or replace function public.get_tenant_missed_days(
  p_window_days integer,
  p_as_of date default CURRENT_DATE
)
returns table(tenant_id uuid, missed_days integer)
language sql
stable
security definer
set search_path to 'public'
as $function$
  WITH window_days AS (
    SELECT generate_series(
      (p_as_of - (GREATEST(p_window_days, 1) - 1) * INTERVAL '1 day')::date,
      p_as_of,
      INTERVAL '1 day'
    )::date AS d
  ),
  active_tenants AS (
    SELECT
      rr.tenant_id,
      MIN(rr.created_at)::date AS earliest_active,
      COALESCE(MAX(rr.daily_repayment), 0)::numeric AS daily_expected
    FROM public.rent_requests rr
    WHERE rr.status IN ('funded', 'disbursed', 'repaying')
      AND rr.created_at::date <= p_as_of
    GROUP BY rr.tenant_id
  ),
  daily_paid AS (
    SELECT
      ac.tenant_id,
      (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS pd,
      SUM(ac.amount)::numeric AS paid_amount
    FROM public.agent_collections ac
    WHERE ac.amount > 0
      AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date
          BETWEEN (p_as_of - (GREATEST(p_window_days, 1) - 1)) AND p_as_of
    GROUP BY ac.tenant_id, (ac.created_at AT TIME ZONE 'Africa/Kampala')::date
  ),
  expanded AS (
    SELECT at.tenant_id, at.daily_expected, wd.d
    FROM active_tenants at
    CROSS JOIN window_days wd
    WHERE wd.d >= at.earliest_active
  ),
  missed AS (
    SELECT e.tenant_id, e.d
    FROM expanded e
    WHERE NOT EXISTS (
      SELECT 1 FROM daily_paid p
      WHERE p.tenant_id = e.tenant_id
        AND p.pd = e.d
        AND (e.daily_expected <= 0 OR p.paid_amount >= e.daily_expected)
    )
  )
  SELECT tenant_id, COUNT(*)::int AS missed_days
  FROM missed
  GROUP BY tenant_id
  HAVING COUNT(*) > 0;
$function$;

create or replace function public.get_tenant_missed_dates(
  p_window_days integer,
  p_as_of date default CURRENT_DATE
)
returns table(tenant_id uuid, missed_dates date[])
language sql
stable
security definer
set search_path to 'public'
as $function$
  WITH window_days AS (
    SELECT generate_series(
      (p_as_of - (GREATEST(p_window_days, 1) - 1) * INTERVAL '1 day')::date,
      p_as_of,
      INTERVAL '1 day'
    )::date AS d
  ),
  active_tenants AS (
    SELECT
      rr.tenant_id,
      MIN(rr.created_at)::date AS earliest_active,
      COALESCE(MAX(rr.daily_repayment), 0)::numeric AS daily_expected
    FROM public.rent_requests rr
    WHERE rr.status IN ('funded', 'disbursed', 'repaying')
      AND rr.created_at::date <= p_as_of
    GROUP BY rr.tenant_id
  ),
  daily_paid AS (
    SELECT
      ac.tenant_id,
      (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS pd,
      SUM(ac.amount)::numeric AS paid_amount
    FROM public.agent_collections ac
    WHERE ac.amount > 0
      AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date
          BETWEEN (p_as_of - (GREATEST(p_window_days, 1) - 1)) AND p_as_of
    GROUP BY ac.tenant_id, (ac.created_at AT TIME ZONE 'Africa/Kampala')::date
  ),
  expanded AS (
    SELECT at.tenant_id, at.daily_expected, wd.d
    FROM active_tenants at
    CROSS JOIN window_days wd
    WHERE wd.d >= at.earliest_active
  ),
  missed AS (
    SELECT e.tenant_id, e.d
    FROM expanded e
    WHERE NOT EXISTS (
      SELECT 1 FROM daily_paid p
      WHERE p.tenant_id = e.tenant_id
        AND p.pd = e.d
        AND (e.daily_expected <= 0 OR p.paid_amount >= e.daily_expected)
    )
  )
  SELECT tenant_id, ARRAY_AGG(d ORDER BY d DESC) AS missed_dates
  FROM missed
  GROUP BY tenant_id;
$function$;

revoke all on function public.get_tenant_missed_days(integer, date) from public;
revoke all on function public.get_tenant_missed_dates(integer, date) from public;
grant execute on function public.get_tenant_missed_days(integer, date) to authenticated, service_role;
grant execute on function public.get_tenant_missed_dates(integer, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Part 2: day state.
--
-- The SMS layer must consume obligation state, never re-derive balances --
-- that was the explicit instruction from the meeting, and this codebase has
-- already been bitten by parallel copies of the same rule drifting.
--
-- Sourced from v_tenant_daily_eligibility (the same view
-- get_tenant_repayment_reliability scores from) so "what is owed today" has
-- one origin. Payment days are bucketed in Africa/Kampala, matching Part 1.
--
--   cleared -- paid at least the daily amount due
--   partial -- paid something, but less than due; remainder carries forward
--   unpaid  -- nothing received that day
-- ---------------------------------------------------------------------------
create or replace function public.get_tenant_payment_day_state(
  p_as_of date default ((now() at time zone 'Africa/Kampala')::date),
  p_tenant_ids uuid[] default null
)
returns table (
  tenant_id uuid,
  daily_expected numeric,
  paid_on_day numeric,
  remaining_today numeric,
  outstanding numeric,
  day_state text
)
language sql
stable
security definer
set search_path = public
as $$
  with plans as (
    select e.tenant_id,
           max(greatest(coalesce(e.daily_repayment, 0), 0))::numeric as daily_expected,
           max(coalesce(e.total_repayment, 0) - coalesce(e.amount_repaid, 0))::numeric as outstanding
    from public.v_tenant_daily_eligibility e
    where e.status in ('funded', 'disbursed', 'repaying')
      and (p_tenant_ids is null or e.tenant_id = any (p_tenant_ids))
    group by e.tenant_id
  ),
  paid as (
    select ac.tenant_id, sum(ac.amount)::numeric as paid_on_day
    from public.agent_collections ac
    where ac.amount > 0
      and (ac.created_at at time zone 'Africa/Kampala')::date = p_as_of
      and (p_tenant_ids is null or ac.tenant_id = any (p_tenant_ids))
    group by ac.tenant_id
  )
  select pl.tenant_id,
         pl.daily_expected,
         coalesce(pa.paid_on_day, 0)::numeric as paid_on_day,
         greatest(0, pl.daily_expected - coalesce(pa.paid_on_day, 0))::numeric as remaining_today,
         greatest(0, pl.outstanding)::numeric as outstanding,
         case
           when coalesce(pa.paid_on_day, 0) <= 0 then 'unpaid'
           when pl.daily_expected <= 0 then 'cleared'
           when coalesce(pa.paid_on_day, 0) >= pl.daily_expected then 'cleared'
           else 'partial'
         end as day_state
  from plans pl
  left join paid pa on pa.tenant_id = pl.tenant_id;
$$;

revoke all on function public.get_tenant_payment_day_state(date, uuid[]) from public;
grant execute on function public.get_tenant_payment_day_state(date, uuid[])
  to authenticated, service_role, postgres;

-- ---------------------------------------------------------------------------
-- Part 3a: recent-payment candidates (payment_received / payment_partial).
--
-- Driven by a short sweep rather than a trigger on agent_collections: that
-- table is written by four SECURITY DEFINER money RPCs
-- (agent_allocate_tenant_payment_internal, confirm_field_collection,
-- process_verified_field_deposit, settle_tenant_rent_from_deposit) and
-- hanging outbound HTTP off a money-write path is not a trade worth making
-- for a few minutes of latency. Cost is up to one sweep interval of delay.
--
-- Returns cumulative day state, not the individual payment, so a tenant who
-- pays three times in a day is told where they actually stand.
-- ---------------------------------------------------------------------------
create or replace function public.get_tenant_payment_notice_candidates(
  p_since_minutes int default 20,
  p_as_of date default ((now() at time zone 'Africa/Kampala')::date)
)
returns table (
  tenant_id uuid,
  tenant_name text,
  tenant_phone text,
  daily_expected numeric,
  paid_on_day numeric,
  remaining_today numeric,
  outstanding numeric,
  day_state text,
  last_payment_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with recent as (
    select ac.tenant_id, max(ac.created_at) as last_payment_at
    from public.agent_collections ac
    where ac.amount > 0
      and ac.created_at >= now() - make_interval(mins => greatest(coalesce(p_since_minutes, 20), 1))
      and (ac.created_at at time zone 'Africa/Kampala')::date = p_as_of
    group by ac.tenant_id
  )
  select s.tenant_id,
         p.full_name as tenant_name,
         p.phone as tenant_phone,
         s.daily_expected,
         s.paid_on_day,
         s.remaining_today,
         s.outstanding,
         s.day_state,
         r.last_payment_at
  from recent r
  join public.get_tenant_payment_day_state(p_as_of, null) s on s.tenant_id = r.tenant_id
  join public.profiles p on p.id = s.tenant_id
  where p.deleted_at is null
    and coalesce(p.phone, '') <> ''
    and s.day_state in ('cleared', 'partial');
$$;

revoke all on function public.get_tenant_payment_notice_candidates(int, date) from public;
grant execute on function public.get_tenant_payment_notice_candidates(int, date)
  to authenticated, service_role, postgres;

-- ---------------------------------------------------------------------------
-- Part 3b: missed-obligation candidates (payment_missed).
--
-- Volume guard, measured against production on 2026-09-09. 551 tenants had an
-- unpaid daily obligation for the previous day. Messaging all of them every
-- day would mean a permanent daily SMS to people who are not participating at
-- all -- across the wider missed-day population only 205 had paid within the
-- last 3 days, while 168 had not paid in over 30 days and 81 had never paid.
--
--   p_require_prior_payment -- excludes tenants who have never paid at all
--       (default true). "You missed today's payment" is the wrong first
--       message for someone who has never started; they need onboarding.
--       Removes 59 of the 551.
--   p_max_days_since_last_payment -- excludes dormant tenants (default 30).
--       Those belong on a call-centre list, not a daily SMS loop.
--       Removes a further 136.
--
-- With both defaults the daily population is 356 rather than 551.
-- ---------------------------------------------------------------------------
create or replace function public.get_tenant_missed_obligation_candidates(
  p_as_of date default ((now() at time zone 'Africa/Kampala')::date - 1),
  p_max_days_since_last_payment int default 30,
  p_require_prior_payment boolean default true
)
returns table (
  tenant_id uuid,
  tenant_name text,
  tenant_phone text,
  daily_expected numeric,
  outstanding numeric,
  last_pay_date date,
  days_since_last_payment int
)
language sql
stable
security definer
set search_path = public
as $$
  with last_pay as (
    select ac.tenant_id,
           max((ac.created_at at time zone 'Africa/Kampala')::date) as last_pay_date
    from public.agent_collections ac
    where ac.amount > 0
    group by ac.tenant_id
  )
  select s.tenant_id,
         p.full_name as tenant_name,
         p.phone as tenant_phone,
         s.daily_expected,
         s.outstanding,
         lp.last_pay_date,
         (p_as_of - lp.last_pay_date) as days_since_last_payment
  from public.get_tenant_payment_day_state(p_as_of, null) s
  join public.profiles p on p.id = s.tenant_id
  left join last_pay lp on lp.tenant_id = s.tenant_id
  where s.day_state = 'unpaid'
    and s.daily_expected > 0
    and p.deleted_at is null
    and coalesce(p.phone, '') <> ''
    and (not p_require_prior_payment or lp.last_pay_date is not null)
    and (
      p_max_days_since_last_payment is null
      or lp.last_pay_date is null
      or (p_as_of - lp.last_pay_date) <= p_max_days_since_last_payment
    );
$$;

revoke all on function public.get_tenant_missed_obligation_candidates(date, int, boolean) from public;
grant execute on function public.get_tenant_missed_obligation_candidates(date, int, boolean)
  to authenticated, service_role, postgres;
