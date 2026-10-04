-- SMS cost/usage reporting — "show me what I'm spending on Yoola credits."
--
-- Why not just sum sms_delivery_log.cost: that column is the provider's own
-- self-reported figure, populated for only ~70% of Yoola rows in the last 30
-- days, and the populated values contain clear errors (e.g. multiple 87-char
-- messages -- comfortably a single 160-char GSM-7 segment, should cost
-- UGX 30 -- logged at UGX 360 or UGX 390; 21 rows logged at UGX 0 despite
-- 220-370 character bodies). It cannot be trusted as a complete or accurate
-- record on its own.
--
-- This computes cost independently from message length using the standard
-- GSM-7 / UCS-2 segmentation rule, at UGX 30 per segment (confirmed against
-- the majority, sane cluster of existing cost values: UGX 30 up to 160 chars,
-- UGX 60 up to ~306, UGX 90 up to ~401 -- i.e. 153 chars/segment once
-- concatenated, 160 for a single segment). A message containing any
-- non-ASCII character is treated as UCS-2 (70 chars single-segment, 67/segment
-- concatenated) -- Welile's SMS copy is English-only in practice, so this
-- only matters if that ever changes.

create or replace function public.sms_segment_count(p_message text)
returns integer
language sql
immutable
as $$
  select case
    when p_message is null or length(p_message) = 0 then 0
    when p_message ~ '[^\x00-\x7F]' then
      case when char_length(p_message) <= 70 then 1
           else ceil(char_length(p_message)::numeric / 67) end
    else
      case when char_length(p_message) <= 160 then 1
           else ceil(char_length(p_message)::numeric / 153) end
  end::integer;
$$;

create or replace function public.sms_cost_ugx(p_message text)
returns integer
language sql
immutable
as $$
  select 30 * public.sms_segment_count(p_message);
$$;

-- ---------------------------------------------------------------------------
-- Reporting RPC. Every attempted send counts toward segments/cost regardless
-- of final status -- Yoola (and every provider) charges on acceptance of the
-- send, not on confirmed handset delivery, so a 'failed' row after the
-- provider accepted it still consumed credit. Rows with status = 'skipped'
-- (governor/frequency-cap refusals, never reached a provider) are excluded
-- from cost entirely since nothing was sent.
-- ---------------------------------------------------------------------------
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
    select l.*, public.sms_segment_count(l.message) as segments, public.sms_cost_ugx(l.message) as cost_ugx
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
    select l.created_at::date as day, l.provider, public.sms_segment_count(l.message) as segments, public.sms_cost_ugx(l.message) as cost_ugx
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
    select l.provider, public.sms_segment_count(l.message) as segments, public.sms_cost_ugx(l.message) as cost_ugx
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
    select l.source, public.sms_segment_count(l.message) as segments, public.sms_cost_ugx(l.message) as cost_ugx
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

revoke all on function public.get_sms_cost_report(date, date, text) from public;
grant execute on function public.get_sms_cost_report(date, date, text) to authenticated;
grant execute on function public.get_sms_cost_report(date, date, text) to service_role, postgres;

grant execute on function public.sms_segment_count(text) to authenticated, service_role, postgres;
grant execute on function public.sms_cost_ugx(text) to authenticated, service_role, postgres;
