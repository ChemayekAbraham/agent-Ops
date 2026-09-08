-- Coverage split for the Agent Collections Command Center.
--
-- The Command Center's coverage figure divides *all* cash received in a window
-- by the pinned expectation for that window. Tenants clear older bills every
-- day, so the numerator contains money the denominator never billed and the
-- ratio reads roughly twice the truth (2026-09-08: 93% naive vs 41.8% real).
--
-- This function splits the collected side by whether the plan was actually on
-- the window's bill, so coverage can be computed honestly and the arrears money
-- can be reported as its own figure instead of silently inflating attainment.
--
-- Additive on purpose: get_agent_collections_command_center is untouched, keeps
-- returning `collected` as total cash, and this runs alongside it. It reads the
-- pins but never writes them — the Command Center RPC owns pinning.
--
-- Coverage basis is UNCAPPED: every shilling received against a billed plan
-- counts, including an overpayment beyond that plan's daily instalment. A
-- capped basis (LEAST(paid, expected) per plan) reads materially lower and
-- answers a different question ("did each tenant meet their own obligation").

create or replace function public.get_agent_collections_coverage(
  p_start timestamptz,
  p_end   timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_d1 date;
  v_d2 date;
  v_today date;
  v_asof date;
  v_expected numeric := 0;
  v_result jsonb;
begin
  -- Same gate as get_agent_collections_command_center. Keep them in step.
  if not (
    has_role(auth.uid(), 'manager') or has_role(auth.uid(), 'super_admin')
    or has_role(auth.uid(), 'ceo') or has_role(auth.uid(), 'coo')
    or has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'operations')
    or has_role(auth.uid(), 'agent_ops')
  ) then
    raise exception 'not authorized';
  end if;

  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'invalid range';
  end if;

  v_today := (now() at time zone 'Africa/Kampala')::date;
  v_d1    := (p_start at time zone 'Africa/Kampala')::date;
  v_d2    := ((p_end - interval '1 microsecond') at time zone 'Africa/Kampala')::date;
  v_asof  := least(v_d2, v_today);

  select coalesce(sum(p.expected_ugx), 0)
    into v_expected
  from public.agent_expected_day_plans p
  where p.day between v_d1 and v_asof;

  with bill as (
    -- Plans billed on any elapsed day inside the window. A tenant billed on
    -- Monday who pays on Wednesday has still paid a bill this window owns,
    -- which is why this is not matched day-for-day.
    select distinct p.rent_request_id
    from public.agent_expected_day_plans p
    where p.day between v_d1 and v_asof
  ),
  cash as (
    select ac.agent_id, ac.rent_request_id, ac.amount
    from public.agent_collections ac
    where ac.created_at >= p_start
      and ac.created_at <  p_end
      and ac.amount > 0
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
      -- Token/QR collections carry no rent_request_id, so they can be neither
      -- matched nor called arrears. Surfaced rather than folded into either.
      coalesce(sum(c.amount) filter (where c.rent_request_id is null), 0) as unattributed
    from cash c
  ),
  per_agent as (
    select c.agent_id,
      coalesce(sum(c.amount), 0) as collected,
      coalesce(sum(c.amount) filter (
        where exists (select 1 from bill b where b.rent_request_id = c.rent_request_id)
      ), 0) as collected_on_schedule
    from cash c
    where c.agent_id is not null
    group by c.agent_id
  )
  select jsonb_build_object(
    'range', jsonb_build_object('start', p_start, 'end', p_end),
    'expected_due', v_expected,
    'expected_basis', 'pinned_schedule',
    'expected_as_of', to_char(v_asof, 'YYYY-MM-DD'),
    'collected_total', s.total,
    'collected_on_schedule', s.on_schedule,
    'collected_arrears', s.arrears,
    'collected_unattributed', s.unattributed,
    'coverage_pct', case when v_expected > 0
                         then round(100.0 * s.on_schedule / v_expected, 1)
                         else null end,
    'coverage_basis', 'uncapped_on_billed_plans',
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'agent_id', a.agent_id,
        'collected', a.collected,
        'collected_on_schedule', a.collected_on_schedule
      ) order by a.collected_on_schedule desc)
      from per_agent a
    ), '[]'::jsonb),
    'generated_at', now()
  )
  into v_result
  from split s;

  return v_result;
end;
$$;

comment on function public.get_agent_collections_coverage(timestamptz, timestamptz) is
  'Splits collections in a window into money against that window''s pinned bill vs arrears vs unattributed, so coverage is not inflated by tenants clearing older bills. Uncapped basis. Reads pins written by get_agent_collections_command_center.';

revoke all on function public.get_agent_collections_coverage(timestamptz, timestamptz) from public;
grant execute on function public.get_agent_collections_coverage(timestamptz, timestamptz) to authenticated;
