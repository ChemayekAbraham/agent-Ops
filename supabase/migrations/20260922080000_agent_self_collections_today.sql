-- Self-scoped "today's expected vs collected" for an individual agent.
--
-- get_agent_collections_coverage() already computes this correctly (pinned
-- bill vs receipt book, on-schedule/arrears split, reversed rows excluded)
-- but is role-gated to manager/super_admin/ceo/coo/cfo/operations/agent_ops
-- for the CFO Command Center — an ordinary field agent has none of those
-- roles and cannot call it for their own numbers. This mirrors the exact
-- same corrected logic, scoped to auth.uid() and today (Africa/Kampala),
-- for the native app's agent home dashboard.
--
-- Per docs/HANDOVER and the welile-expected-vs-collected skill: never divide
-- SUM(agent_collections.amount) by SUM(agent_expected_day_plans.expected_ugx)
-- for a date range — tenants pay off older bills every day, inflating the
-- numerator against a denominator that never billed that arrears. Report the
-- bill and the on-schedule/arrears split as separate figures instead.
--
-- Known open issue (not solved here): agent_expected_day_plans.agent_id is
-- plain rent_requests.agent_id, while some reporting paths credit collections
-- to COALESCE(assigned_agent_id, agent_id) — a reassigned plan's bill and
-- cash can land on different agents. This function uses agent_collections.agent_id
-- directly, same basis get_agent_collections_coverage's own per-agent split uses.

CREATE OR REPLACE FUNCTION public.get_my_agent_collections_today()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_agent_id uuid := auth.uid();
  v_today date;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_expected numeric := 0;
  v_result jsonb;
begin
  if v_agent_id is null then
    raise exception 'not authorized';
  end if;

  v_today := (now() at time zone 'Africa/Kampala')::date;
  v_day_start := v_today::timestamp at time zone 'Africa/Kampala';
  v_day_end := (v_today + 1)::timestamp at time zone 'Africa/Kampala';

  select coalesce(sum(p.expected_ugx), 0)
    into v_expected
  from public.agent_expected_day_plans p
  where p.day = v_today
    and p.agent_id = v_agent_id;

  with bill as (
    select distinct p.rent_request_id
    from public.agent_expected_day_plans p
    where p.day = v_today
      and p.agent_id = v_agent_id
  ),
  cash as (
    select ac.rent_request_id, ac.amount
    from public.agent_collections ac
    where ac.agent_id = v_agent_id
      and ac.created_at >= v_day_start
      and ac.created_at <  v_day_end
      and ac.amount > 0
      and ac.reversed_at is null
  ),
  split as (
    select
      coalesce(sum(c.amount), 0) as total,
      coalesce(sum(c.amount) filter (
        where exists (select 1 from bill b where b.rent_request_id = c.rent_request_id)
      ), 0) as on_schedule,
      coalesce(sum(c.amount) filter (
        where c.rent_request_id is not null
          and not exists (select 1 from bill b where b.rent_request_id = c.rent_request_id)
      ), 0) as arrears,
      coalesce(sum(c.amount) filter (where c.rent_request_id is null), 0) as unattributed
    from cash c
  )
  select jsonb_build_object(
    'day', to_char(v_today, 'YYYY-MM-DD'),
    'expected_due', v_expected,
    'expected_basis', 'pinned_schedule',
    'collected_total', s.total,
    'collected_on_schedule', s.on_schedule,
    'collected_arrears', s.arrears,
    'collected_unattributed', s.unattributed,
    'coverage_pct', case when v_expected > 0
                         then round(100.0 * s.on_schedule / v_expected, 1)
                         else null end,
    'coverage_basis', 'uncapped_on_billed_plans',
    'generated_at', now()
  )
  into v_result
  from split s;

  return coalesce(v_result, jsonb_build_object(
    'day', to_char(v_today, 'YYYY-MM-DD'),
    'expected_due', 0,
    'expected_basis', 'pinned_schedule',
    'collected_total', 0,
    'collected_on_schedule', 0,
    'collected_arrears', 0,
    'collected_unattributed', 0,
    'coverage_pct', null,
    'coverage_basis', 'uncapped_on_billed_plans',
    'generated_at', now()
  ));
end;
$function$;

GRANT EXECUTE ON FUNCTION public.get_my_agent_collections_today() TO authenticated;
