create or replace function public.get_advance_growth_cohorts()
returns table (
  advance_id uuid,
  agent_id uuid,
  full_name text,
  phone text,
  status text,
  outstanding numeric,
  paid_14 numeric,
  interest_14 numeric,
  paid_days integer,
  cohort text
)
language sql
stable
security definer
set search_path = public
as $$
  with l as (
    select advance_id,
           count(*) filter (where amount_deducted > 0)::int as paid_days,
           coalesce(sum(amount_deducted),0) as paid_14,
           coalesce(sum(interest_accrued),0) as interest_14
    from agent_advance_ledger
    where date >= current_date - 14
    group by advance_id
  )
  select a.id,
         a.agent_id,
         p.full_name,
         p.phone,
         a.status,
         a.outstanding_balance,
         l.paid_14,
         l.interest_14,
         l.paid_days,
         case
           when l.interest_14 > l.paid_14 and l.paid_days >= 3 then 'deducting_but_growing'
           when l.interest_14 > l.paid_14 then 'growing_no_deduction'
           when l.interest_14 > 0 then 'overdue_but_reducing'
           when l.paid_days = 0 then 'flat_no_collection'
           else 'reducing_normally'
         end as cohort
  from l
  join agent_advances a on a.id = l.advance_id
  left join profiles p on p.id = a.agent_id
  where a.status in ('active','overdue')
    and a.outstanding_balance > 0
$$;

revoke all on function public.get_advance_growth_cohorts() from public;
grant execute on function public.get_advance_growth_cohorts() to service_role;