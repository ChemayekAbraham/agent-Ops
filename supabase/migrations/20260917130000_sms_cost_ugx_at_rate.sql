-- Africa's Talking bills UGX 25/segment, not UGX 30 -- confirmed directly by
-- AT support (2026-09-17): "The 25 UGX per message applies to up to 160
-- characters in a single SMS... If your message includes special/unicode
-- characters... the limit drops to 70 characters per message." Same
-- GSM-7/UCS-2 segmentation thresholds as sms_segment_count() already uses,
-- different price per segment.
--
-- 20260917100000_sms_cost_report.sql applied a flat UGX 30/segment to every
-- provider. That rate was confirmed against Yoola's own logged cost cluster
-- (see that migration's comment) -- it was never checked against AT. Over
-- the last 30 days this overstated africastalking spend by ~UGX 57,465
-- (16.7%): 344,790 computed at 30/segment vs 287,325 at the correct
-- 25/segment (5,582 messages, 11,493 segments). Yoola stays at UGX
-- 30/segment -- unchanged, still the confirmed rate. Other providers seen in
-- sms_delivery_log (lana, twilio, "gate", "pending") have no confirmed rate
-- either way -- left at UGX 30 as before since that's still the best
-- available assumption, not a confirmation.

drop function if exists public.sms_cost_ugx(text);

create or replace function public.sms_cost_ugx(p_message text, p_provider text default null)
returns integer
language sql
immutable
as $$
  select (case when p_provider = 'africastalking' then 25 else 30 end)
    * public.sms_segment_count(p_message);
$$;

grant execute on function public.sms_cost_ugx(text, text) to authenticated, service_role, postgres;

create or replace function public.get_sms_cost_report(
  p_start date default (current_date - 29),
  p_end date default current_date,
  p_provider text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_totals jsonb;
  v_daily jsonb;
  v_by_provider jsonb;
  v_by_source jsonb;
begin
  if not (
    public.has_role(auth.uid(),'cfo') or public.has_role(auth.uid(),'ceo')
    or public.has_role(auth.uid(),'coo') or public.has_role(auth.uid(),'cto')
    or public.has_role(auth.uid(),'super_admin') or public.has_role(auth.uid(),'manager')
    or public.has_role(auth.uid(),'operations')
  ) then
    raise exception 'not authorized';
  end if;

  with scoped as (
    select l.*, public.sms_segment_count(l.message) as segments,
      public.sms_cost_ugx(l.message, l.provider) as cost_ugx
    from public.sms_delivery_log l
    where l.created_at::date between p_start and p_end
      and l.status <> 'skipped'
      and (p_provider is null or l.provider = p_provider)
  )
  select jsonb_build_object(
    'messages', count(*),
    'segments', coalesce(sum(segments), 0),
    'cost_ugx', coalesce(sum(cost_ugx), 0),
    'sent', count(*) filter (where status in ('sent','success','delivered','accepted')),
    'failed', count(*) filter (where status = 'failed'),
    'cost_ugx_sent_only', coalesce(sum(cost_ugx) filter (where status in ('sent','success','delivered','accepted')), 0)
  )
  into v_totals
  from scoped;

  with scoped as (
    select l.created_at::date as day, l.provider, public.sms_segment_count(l.message) as segments,
      public.sms_cost_ugx(l.message, l.provider) as cost_ugx
    from public.sms_delivery_log l
    where l.created_at::date between p_start and p_end
      and l.status <> 'skipped'
      and (p_provider is null or l.provider = p_provider)
  )
  select coalesce(jsonb_agg(x order by x.day), '[]'::jsonb)
  into v_daily
  from (
    select day,
      count(*) as messages,
      sum(segments) as segments,
      sum(cost_ugx) as cost_ugx,
      count(*) filter (where provider = 'yoola') as yoola_messages,
      sum(cost_ugx) filter (where provider = 'yoola') as yoola_cost_ugx,
      count(*) filter (where provider = 'africastalking') as at_messages,
      sum(cost_ugx) filter (where provider = 'africastalking') as at_cost_ugx,
      count(*) filter (where provider not in ('yoola','africastalking')) as other_messages,
      sum(cost_ugx) filter (where provider not in ('yoola','africastalking')) as other_cost_ugx
    from scoped
    group by day
  ) x;

  with scoped as (
    select l.provider, public.sms_segment_count(l.message) as segments,
      public.sms_cost_ugx(l.message, l.provider) as cost_ugx
    from public.sms_delivery_log l
    where l.created_at::date between p_start and p_end
      and l.status <> 'skipped'
  )
  select coalesce(jsonb_agg(x order by x.cost_ugx desc), '[]'::jsonb)
  into v_by_provider
  from (
    select coalesce(provider, 'none') as provider,
      count(*) as messages, sum(segments) as segments, sum(cost_ugx) as cost_ugx
    from scoped
    group by provider
  ) x;

  with scoped as (
    select l.source, public.sms_segment_count(l.message) as segments,
      public.sms_cost_ugx(l.message, l.provider) as cost_ugx
    from public.sms_delivery_log l
    where l.created_at::date between p_start and p_end
      and l.status <> 'skipped'
      and (p_provider is null or l.provider = p_provider)
  )
  select coalesce(jsonb_agg(x order by x.cost_ugx desc), '[]'::jsonb)
  into v_by_source
  from (
    select coalesce(source, 'unknown') as source,
      count(*) as messages, sum(segments) as segments, sum(cost_ugx) as cost_ugx
    from scoped
    group by source
    order by sum(cost_ugx) desc
    limit 30
  ) x;

  return jsonb_build_object(
    'start_date', p_start,
    'end_date', p_end,
    'provider_filter', p_provider,
    'totals', v_totals,
    'daily', v_daily,
    'by_provider', v_by_provider,
    'by_source', v_by_source,
    'generated_at', now()
  );
end;
$$;
