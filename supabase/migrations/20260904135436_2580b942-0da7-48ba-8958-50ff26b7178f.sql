create or replace view public.v_rent_plan_schedule
with (security_invoker = on) as
with pay as (
  select x.rent_request_id,
         max((x.created_at at time zone 'Africa/Kampala')::date) as last_pay_date
  from (
    select agent_collections.rent_request_id, agent_collections.created_at
    from agent_collections where agent_collections.rent_request_id is not null
    union all
    select repayments.rent_request_id, repayments.created_at
    from repayments where repayments.rent_request_id is not null
  ) x
  group by x.rent_request_id
)
select rr.id as rent_request_id,
  rr.agent_id,
  rr.tenant_id,
  coalesce(rr.daily_repayment, 0::numeric) as daily_amount,
  coalesce(rr.total_repayment, 0::numeric) as total_amount,
  coalesce(rr.amount_repaid, 0::numeric) as amount_repaid,
  s.term_start,
  s.term_end,
  coalesce(rr.duration_days, 0) as term_days,
  o.obligation_end,
  o.obligation_end - s.term_start + 1 as oblig_days,
  (rr.status = any (array['funded'::text,'repaying'::text])) and (coalesce(rr.total_repayment,0::numeric) - coalesce(rr.amount_repaid,0::numeric)) > 0::numeric as is_live
from rent_requests rr
  left join pay on pay.rent_request_id = rr.id
  cross join lateral (
    select coalesce(rr.repayment_starts_on, (coalesce(rr.funded_at, rr.disbursed_at, rr.created_at) at time zone 'Africa/Kampala')::date) as term_start,
           coalesce(rr.repayment_starts_on, (coalesce(rr.funded_at, rr.disbursed_at, rr.created_at) at time zone 'Africa/Kampala')::date) + coalesce(rr.duration_days,0) - 1 as term_end
  ) s
  cross join lateral (
    select case
      when coalesce(rr.total_repayment,0) - coalesce(rr.amount_repaid,0) > 0 then s.term_end
      else least(s.term_end, coalesce(pay.last_pay_date, s.term_start - 1))
    end as obligation_end
  ) o
where s.term_start is not null
  and (rr.status = any (array['funded'::text,'repaying'::text,'completed'::text]))
  and coalesce(rr.agent_payment_status, 'paying'::text) <> 'not_paying'::text
  and rr.tenancy_status = 'active'::text
  and rr.tenancy_ended_at is null
  and coalesce(rr.duration_days, 0) > 0
  and not (exists (
    select 1 from rent_repayment_pauses pz
    where pz.rent_request_id = rr.id and pz.status = 'active'::text and pz.resumed_at is null
  ));

comment on view public.v_rent_plan_schedule is 'Canonical rent plan schedule: term window from repayment_starts_on, obligation_end closes at last payment date for settled plans (no updated_at proxy).';

revoke all on public.v_rent_plan_schedule from anon;