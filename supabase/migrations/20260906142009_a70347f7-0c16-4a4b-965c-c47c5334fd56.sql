create or replace function public.get_agent_collection_records(
  p_agent_id uuid,
  p_start timestamptz,
  p_end timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not authorised';
  end if;

  if not (
    auth.uid() = p_agent_id
    or exists (
      select 1 from public.user_roles ur
      where ur.user_id = auth.uid()
        and ur.enabled = true
        and ur.role in ('manager','super_admin','ceo','coo','cfo','operations','agent_ops','tenant_ops','landlord_ops','financial_ops')
    )
  ) then
    raise exception 'Not authorised';
  end if;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb)
    into v
  from (
    select c.id,
           c.created_at,
           c.amount::numeric as amount,
           coalesce(tp.full_name, tp.phone, 'Tenant') as tenant_name,
           tp.phone as tenant_phone,
           coalesce(rq.repayment_frequency, 'daily') as cycle,
           case lower(coalesce(rq.repayment_frequency, 'daily'))
             when 'weekly' then coalesce(rq.daily_repayment, 0) * 7
             when 'monthly' then coalesce(rq.daily_repayment, 0) * 30
             else coalesce(rq.daily_repayment, 0)
           end::numeric as expected_amount,
           greatest(
             coalesce(rq.total_repayment, rq.rent_amount, 0) - coalesce(rq.amount_repaid, 0),
             0
           )::numeric as tenant_outstanding
      from public.agent_collections c
      left join public.profiles tp on tp.id = c.tenant_id
      left join lateral (
        select rr.total_repayment, rr.rent_amount, rr.amount_repaid,
               rr.daily_repayment, rr.repayment_frequency
          from public.rent_requests rr
         where rr.id = c.rent_request_id
            or (c.rent_request_id is null and rr.tenant_id = c.tenant_id and rr.agent_id = c.agent_id)
         order by (rr.id = c.rent_request_id) desc, rr.created_at desc
         limit 1
      ) rq on true
     where c.agent_id = p_agent_id
       and c.amount > 0
       and c.created_at >= p_start
       and c.created_at <= p_end
  ) r;

  return v;
end;
$function$;