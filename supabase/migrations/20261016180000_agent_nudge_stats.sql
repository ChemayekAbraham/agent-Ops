-- Agent dashboard nudges: the numbers behind the toasts.
--
-- The copy lives in src/lib/agentNudges/nudges.json; this returns, for the
-- signed-in agent, every figure those messages may quote, in one read-only
-- call. Field meanings match AgentNudgeStats in src/lib/agentNudges/index.ts.
--
-- Bases (Kampala calendar day throughout):
--   * The bill is today's pin in agent_expected_day_plans for this agent. A
--     plan counts as collected when it has a live collection today from any
--     agent, matched per rent_request_id, never by dividing totals. Plans
--     funded today are not on the bill; they start repaying tomorrow.
--   * uncollected_count is plans with nothing paid today; uncollected_amount is
--     what is still owed against today's bill, capped per plan.
--   * missed_commission applies the agent's own rate (8% for a linked,
--     non-whitelisted sub-agent, else 10%) from get_agent_commission_rate.
--   * earned_commission_today is the net agent_commission_earned on the agent's
--     wallet today, so it includes any 2% recruiter override they earned.
--   * Active agents today are those with a live agent_collections row today.
--     Rank is among them by amount collected today (1 = most), ties shared.
--     collected_today is that same total: all cash, arrears included.
--   * Live collection = amount > 0, reversed_at null and no [REVERSED:] note.
--   * A new tenant is one whose first non-cancelled rent request from this
--     agent was made in the window; renewals of an existing tenant don't count.

CREATE OR REPLACE FUNCTION public._agent_nudge_stats(p_agent_id uuid, p_day date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
with
bounds as (
  select (p_day::timestamp at time zone 'Africa/Kampala')       as t0,
         ((p_day + 1)::timestamp at time zone 'Africa/Kampala') as t1,
         ((p_day - 1)::timestamp at time zone 'Africa/Kampala') as ty
),
live as (
  select ac.agent_id, ac.rent_request_id, ac.amount, ac.created_at
  from agent_collections ac, bounds b
  where ac.created_at >= b.ty and ac.created_at < b.t1
    and ac.amount > 0 and ac.reversed_at is null
    and (ac.notes is null or ac.notes not ilike '%[REVERSED:%')
),
board as (
  select (l.created_at >= b.t0) as is_today, l.agent_id, sum(l.amount) as total
  from live l, bounds b
  group by 1, 2
),
ranked as (
  select is_today, agent_id, total,
         rank()   over (partition by is_today order by total desc) as rnk,
         count(*) over (partition by is_today)                     as n
  from board
),
me_today as (select * from ranked where is_today and agent_id = p_agent_id),
me_yday  as (select * from ranked where not is_today and agent_id = p_agent_id),
paid_today as (
  select l.rent_request_id, sum(l.amount) as amt
  from live l, bounds b
  where l.created_at >= b.t0
  group by 1
),
bill as (
  select ep.rent_request_id, ep.tenant_id, ep.expected_ugx, coalesce(pt.amt, 0) as paid
  from agent_expected_day_plans ep
  left join paid_today pt on pt.rent_request_id = ep.rent_request_id
  where ep.day = p_day and ep.agent_id = p_agent_id
),
top_unpaid as (
  select b.tenant_id, b.expected_ugx
  from bill b
  where b.paid = 0
  order by b.expected_ugx desc, b.rent_request_id
  limit 1
),
rate as (
  select coalesce((public.get_agent_commission_rate(p_agent_id) ->> 'agent_rate')::numeric, 0.10) as r
),
commission as (
  select coalesce(sum(case when gl.direction = 'cash_in' then gl.amount else -gl.amount end), 0) as amt
  from general_ledger gl, bounds b
  where gl.user_id = p_agent_id
    and gl.ledger_scope = 'wallet'
    and gl.category = 'agent_commission_earned'
    and gl.created_at >= b.t0 and gl.created_at < b.t1
),
coll_days as (
  select distinct (ac.created_at at time zone 'Africa/Kampala')::date as d
  from agent_collections ac, bounds b
  where ac.agent_id = p_agent_id
    and ac.amount > 0 and ac.reversed_at is null
    and (ac.notes is null or ac.notes not ilike '%[REVERSED:%')
    and ac.created_at >= b.t0 - interval '400 days' and ac.created_at < b.t1
),
anchor as (
  select case when exists (select 1 from coll_days where d = p_day) then p_day else p_day - 1 end as a
),
streak as (
  select count(*) as n
  from (
    select c.d, row_number() over (order by c.d desc) as rn
    from coll_days c, anchor
    where c.d <= anchor.a
  ) s, anchor
  where anchor.a - s.d = s.rn - 1
),
my_tenants as (
  select rr.tenant_id,
         min((rr.created_at at time zone 'Africa/Kampala')::date) as first_day,
         bool_or(rr.status in ('funded', 'disbursed', 'repaying')) as active
  from rent_requests rr
  where rr.agent_id = p_agent_id
    and rr.tenant_id is not null
    and rr.status not in ('cancelled', 'rejected', 'deleted_by_agent')
  group by rr.tenant_id
)
select jsonb_build_object(
  'first_name',              (select nullif(split_part(trim(p.full_name), ' ', 1), '') from profiles p where p.id = p_agent_id),
  'due_today_count',         (select count(*) from bill),
  'expected_today',          (select coalesce(sum(expected_ugx), 0) from bill),
  'collected_today_count',   (select count(*) from bill where paid > 0),
  'collected_today',         coalesce((select total from me_today), 0),
  'uncollected_count',       (select count(*) from bill where paid = 0),
  'uncollected_amount',      (select coalesce(sum(greatest(expected_ugx - paid, 0)), 0) from bill),
  'missed_commission',       (select round(coalesce(sum(greatest(expected_ugx - paid, 0)), 0) * (select r from rate)) from bill),
  'earned_commission_today', (select round(amt) from commission),
  'top_tenant_name',         (select nullif(trim(p.full_name), '') from top_unpaid t join profiles p on p.id = t.tenant_id),
  'top_tenant_amount',       (select expected_ugx from top_unpaid),
  'active_agents_today',     coalesce((select max(n) from ranked where is_today), 0),
  'rank_today',              (select rnk from me_today),
  'rank_yesterday',          (select rnk from me_yday),
  'gap_to_next_rank',        (select min(r.total) - m.total from ranked r, me_today m
                               where r.is_today and r.total > m.total group by m.total),
  'streak_days',             (select n from streak),
  'tenants_total',           (select count(*) from my_tenants where active),
  'new_tenants_7d',          (select count(*) from my_tenants where first_day > p_day - 7),
  'days_since_new_tenant',   (select p_day - max(first_day) from my_tenants)
);
$function$;

CREATE OR REPLACE FUNCTION public.get_agent_nudge_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = '28000';
  END IF;
  RETURN public._agent_nudge_stats(auth.uid(), (now() AT TIME ZONE 'Africa/Kampala')::date);
END
$function$;

REVOKE ALL ON FUNCTION public._agent_nudge_stats(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_agent_nudge_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_agent_nudge_stats() TO authenticated;
