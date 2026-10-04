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
    else least(
           s.term_end,
           greatest(
             s.term_start,
             coalesce(pay.last_pay_date,
                      (rr.updated_at at time zone 'Africa/Kampala')::date,
                      s.term_end)
           )
         )
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
  'Canonical repayment schedule cohort. term_end is the contractual end; obligation_end stops at the settlement date for plans already paid off (last payment date, else the row updated_at, clamped into the term), so a settled plan stops being expected. is_live marks plans still owing today. Expected and defaulted figures must derive from this view only.';

revoke all on public.v_rent_plan_schedule from anon;