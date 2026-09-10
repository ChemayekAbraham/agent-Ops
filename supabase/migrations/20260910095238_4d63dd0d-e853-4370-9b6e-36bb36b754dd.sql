create or replace view public.v_cc_tenant_calling_population as
with plan as (
  select distinct on (rr.tenant_id)
    rr.tenant_id,
    rr.id as rent_request_id,
    coalesce(rr.total_repayment, 0)  as total_repayment,
    coalesce(rr.amount_repaid, 0)    as amount_repaid,
    coalesce(rr.daily_repayment, 0)  as daily_repayment,
    rr.funded_at
  from public.rent_requests rr
  where rr.tenant_id is not null
    and rr.status in ('funded', 'repaying')
  order by rr.tenant_id, rr.funded_at desc nulls last, rr.created_at desc
)
select
  p.tenant_id,
  p.rent_request_id,
  greatest(p.total_repayment - p.amount_repaid, 0) as outstanding,
  greatest(
    case
      when p.funded_at is null or p.daily_repayment <= 0 then 0::numeric
      else least(
        p.total_repayment,
        p.daily_repayment * greatest(
          (now() at time zone 'Africa/Kampala')::date - (p.funded_at at time zone 'Africa/Kampala')::date,
          0
        )::numeric
      )
    end - p.amount_repaid,
    0
  ) as arrears_amount
from plan p;

grant select on public.v_cc_tenant_calling_population to authenticated;
grant select on public.v_cc_tenant_calling_population to service_role;

update public.cc_cycle_populations
   set source_view       = 'v_cc_tenant_calling_population',
       subject_id_column = 'tenant_id',
       priority_column   = 'arrears_amount',
       filter_sql        = null,
       label             = 'Tenants on funded or accepted plans',
       updated_at        = now()
 where subject_type = 'tenant'
   and code = 'tenants_active_plans';