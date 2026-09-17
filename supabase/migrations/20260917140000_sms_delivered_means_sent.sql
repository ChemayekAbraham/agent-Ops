-- "Delivered" for SMS has always read 0 in the CTO Communication tab's
-- Tenant Notifications table. Checked production: sms_delivery_log.status =
-- 'delivered' has ZERO rows, ever, across every provider (Yoola, AT, LANA) --
-- not just recently. 20260909170000's comment assumed Africa's Talking's
-- delivery-report callback (sms-delivery-report) would populate it; in
-- practice no provider ever confirms handset delivery back to us, so that
-- column can never be trusted as a delivery signal. Per Josh: treat a
-- provider-accepted send ("sent") as delivered for reporting, since a real
-- delivery confirmation is never coming.
--
-- Fixes both places that read sms_delivery_log.status = 'delivered':
-- get_tenant_notification_performance (5G) and get_tenant_channel_performance
-- (6M)'s sms CTE. The push/in-app branch of the latter is untouched -- those
-- channels do populate real 'delivered'/'opened' statuses.

create or replace function public.get_tenant_notification_performance(
  p_start date default (current_date - 6),
  p_end date default current_date,
  p_event_key text default null,
  p_district text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_totals jsonb;
  v_by_event jsonb;
begin
  if not (
    public.has_role(auth.uid(),'tenant_ops') or public.has_role(auth.uid(),'super_admin')
    or public.has_role(auth.uid(),'manager') or public.has_role(auth.uid(),'coo')
    or public.has_role(auth.uid(),'ceo') or public.has_role(auth.uid(),'cfo')
    or public.has_role(auth.uid(),'operations') or public.has_role(auth.uid(),'agent_ops')
  ) then
    raise exception 'not authorized';
  end if;

  with scoped as (
    select l.*
    from public.tenant_notification_log l
    left join public.profiles p on p.id = l.tenant_id
    where l.created_at::date between p_start and p_end
      and (p_event_key is null or l.event_key = p_event_key)
      and (p_district is null or p.district = p_district)
  )
  select jsonb_build_object(
    'sent', count(*) filter (where status = 'sent'),
    'delivered', count(*) filter (where status = 'sent'),
    'failed', count(*) filter (where status = 'failed'),
    'suppressed', count(*) filter (where status = 'skipped'),
    'unique_tenants', count(distinct tenant_id) filter (where status = 'sent'),
    'acted', count(*) filter (where status = 'sent' and acted_at is not null),
    'conversion_rate_pct', case
      when count(*) filter (where status = 'sent') = 0 then 0
      else round(
        100.0 * count(*) filter (where status = 'sent' and acted_at is not null)
        / count(*) filter (where status = 'sent'), 1
      )
    end
  )
  into v_totals
  from scoped;

  with scoped as (
    select l.*
    from public.tenant_notification_log l
    left join public.profiles p on p.id = l.tenant_id
    where l.created_at::date between p_start and p_end
      and (p_event_key is null or l.event_key = p_event_key)
      and (p_district is null or p.district = p_district)
  )
  select coalesce(jsonb_agg(x order by x.event_key), '[]'::jsonb)
  into v_by_event
  from (
    select
      event_key,
      count(*) filter (where status = 'sent') as sent,
      count(*) filter (where status = 'sent') as delivered,
      count(*) filter (where status = 'failed') as failed,
      count(*) filter (where status = 'skipped') as suppressed,
      count(distinct tenant_id) filter (where status = 'sent') as unique_tenants,
      count(*) filter (where status = 'sent' and acted_at is not null) as acted,
      case
        when count(*) filter (where status = 'sent') = 0 then 0
        else round(
          100.0 * count(*) filter (where status = 'sent' and acted_at is not null)
          / count(*) filter (where status = 'sent'), 1
        )
      end as conversion_rate_pct
    from scoped
    group by event_key
  ) x;

  return jsonb_build_object(
    'start_date', p_start,
    'end_date', p_end,
    'filters', jsonb_build_object('event_key', p_event_key, 'district', p_district),
    'totals', v_totals,
    'by_event', v_by_event,
    'generated_at', now()
  );
end;
$$;

create or replace function public.get_tenant_channel_performance(
  p_start date default (current_date - 6),
  p_end date default current_date,
  p_event_key text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not (
    public.has_role(auth.uid(),'tenant_ops') or public.has_role(auth.uid(),'super_admin')
    or public.has_role(auth.uid(),'manager') or public.has_role(auth.uid(),'coo')
    or public.has_role(auth.uid(),'ceo') or public.has_role(auth.uid(),'cfo')
    or public.has_role(auth.uid(),'operations') or public.has_role(auth.uid(),'agent_ops')
  ) then
    raise exception 'not authorized';
  end if;

  with sms as (
    select l.event_key, 'sms'::text as channel,
           count(*) filter (where l.status = 'sent') as sent,
           count(*) filter (where l.status = 'sent') as delivered,
           count(*) filter (where l.status = 'failed') as failed,
           count(*) filter (where l.status = 'sent' and l.acted_at is not null) as opened_or_acted
    from public.tenant_notification_log l
    where l.created_at::date between p_start and p_end
      and (p_event_key is null or l.event_key = p_event_key)
    group by l.event_key
  ),
  other as (
    select l.event_key, d.channel,
           count(*) filter (where d.status in ('sent','delivered','opened')) as sent,
           count(*) filter (where d.status in ('delivered','opened')) as delivered,
           count(*) filter (where d.status = 'failed') as failed,
           count(*) filter (where d.status = 'opened') as opened_or_acted
    from public.tenant_notification_deliveries d
    join public.tenant_notification_log l on l.id = d.notification_log_id
    where d.created_at::date between p_start and p_end
      and (p_event_key is null or l.event_key = p_event_key)
    group by l.event_key, d.channel
  ),
  combined as (
    select * from sms
    union all
    select * from other
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'event_key', event_key, 'channel', channel,
      'sent', sent, 'delivered', delivered, 'failed', failed,
      'opened_or_acted', opened_or_acted
    ) order by event_key, channel
  ), '[]'::jsonb)
  into v_result
  from combined;

  return jsonb_build_object(
    'start_date', p_start, 'end_date', p_end, 'event_key', p_event_key,
    'rows', v_result, 'generated_at', now()
  );
end;
$$;
