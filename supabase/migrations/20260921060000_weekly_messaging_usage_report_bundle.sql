-- Weekly OTP + SMS usage report bundle.
--
-- Josh built get_otp_usage_by_category (doc 82) and get_sms_cost_report (doc 53)
-- but never got a weekly report out of either: the OTP function only ever landed
-- as a section inside the DAILY tech report, and the SMS cost function has no
-- page and no cron caller at all. This RPC is the data source for a new
-- weekly-messaging-usage-report edge function that emails both together.
--
-- get_sms_cost_report is NOT called from here. Its role guard
-- (cfo/ceo/coo/cto/super_admin/manager/operations via has_role(auth.uid(),...))
-- has no service_role or anon-null fallback, so a cron-invoked edge function
-- calling it with the service-role key would always get "not authorized". The
-- SMS-side aggregation below is re-derived inline from sms_delivery_log using
-- the same sms_segment_count/sms_cost_ugx helpers instead of touching that
-- function's guard.
--
-- The OTP side instead reuses get_otp_usage_by_category(date) once per day in
-- the window and sums the results, rather than re-deriving its category union
-- (otp_login_audit / wallet_withdrawal_otp_* / landlord_payout_otp_* /
-- sms_delivery_log password-reset rows) a second time -- one source of truth
-- per category, matching the "don't fold into a second copy that can drift"
-- lesson from doc 86.
--
-- Tenant notifications get their own section, sourced from
-- tenant_notification_log (joined to sms_delivery_log by sms_log_id for cost)
-- rather than left folded into the generic SMS by-source list -- that list is
-- capped to the top 15 by cost, which silently dropped several real tenant
-- events (RENT_LIMIT_INCREASED, TENANT_RELOCATION, ...), and it has no
-- visibility into skip_reason (event_daily_cap / marketing_weekly_cap /
-- already_sent_this_episode governor skips), which tenant_notification_log
-- does.

create or replace function public.get_messaging_usage_weekly_bundle(
  p_start date default (((now() at time zone 'Africa/Kampala')::date) - 7),
  p_end   date default (((now() at time zone 'Africa/Kampala')::date) - 1)
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_otp_totals jsonb;
  v_otp_by_category jsonb;
  v_otp_daily jsonb;
  v_sms_totals jsonb;
  v_sms_daily jsonb;
  v_sms_by_provider jsonb;
  v_sms_by_source jsonb;
  v_tenant_totals jsonb;
  v_tenant_by_event jsonb;
  v_tenant_skip_reasons jsonb;
begin
  if not (
    public.has_role(auth.uid(), 'cto') or public.has_role(auth.uid(), 'ceo')
    or public.has_role(auth.uid(), 'cfo') or public.has_role(auth.uid(), 'coo')
    or public.has_role(auth.uid(), 'super_admin') or public.has_role(auth.uid(), 'manager')
    or public.has_role(auth.uid(), 'operations')
    or auth.role() = 'service_role' or auth.uid() is null
  ) then
    raise exception 'Not authorised';
  end if;

  -- ---- OTP usage: one call per day to the existing, already-verified RPC ----
  with days as (
    select d::date as day, public.get_otp_usage_by_category(d::date) as j
    from generate_series(p_start, p_end, interval '1 day') d
  ),
  cats as (
    select day,
           c->>'category' as category,
           coalesce((c->>'sent')::bigint, 0) as sent,
           coalesce((c->>'send_failed')::bigint, 0) as send_failed,
           coalesce((c->>'verify_success')::bigint, 0) as verify_success,
           coalesce((c->>'verify_failed')::bigint, 0) as verify_failed
    from days, jsonb_array_elements(j->'by_category') c
  )
  select
    coalesce((select jsonb_build_object(
      'sent', sum(sent), 'send_failed', sum(send_failed),
      'verify_success', sum(verify_success), 'verify_failed', sum(verify_failed)
    ) from cats), jsonb_build_object('sent', 0, 'send_failed', 0, 'verify_success', 0, 'verify_failed', 0)),
    coalesce((select jsonb_agg(x order by (x.sent + x.verify_success + x.verify_failed) desc) from (
      select category, sum(sent) as sent, sum(send_failed) as send_failed,
             sum(verify_success) as verify_success, sum(verify_failed) as verify_failed
      from cats group by category
    ) x), '[]'::jsonb),
    coalesce((select jsonb_agg(x order by x.day) from (
      select day, sum(sent) as sent, sum(send_failed) as send_failed,
             sum(verify_success) as verify_success, sum(verify_failed) as verify_failed
      from cats group by day
    ) x), '[]'::jsonb)
  into v_otp_totals, v_otp_by_category, v_otp_daily;

  -- ---- SMS cost/usage: same segmentation math as get_sms_cost_report, ----
  -- ---- re-derived here rather than calling it (see header comment). ----
  with scoped as (
    select l.*, public.sms_segment_count(l.message) as segments,
           public.sms_cost_ugx(l.message, l.provider) as cost_ugx
    from public.sms_delivery_log l
    where l.created_at::date between p_start and p_end
      and l.status <> 'skipped'
  )
  select jsonb_build_object(
    'messages', count(*),
    'segments', coalesce(sum(segments), 0),
    'cost_ugx', coalesce(sum(cost_ugx), 0),
    'sent', count(*) filter (where status in ('sent','success','delivered','accepted')),
    'failed', count(*) filter (where status = 'failed')
  )
  into v_sms_totals
  from scoped;

  with scoped as (
    select l.created_at::date as day, public.sms_segment_count(l.message) as segments,
           public.sms_cost_ugx(l.message, l.provider) as cost_ugx
    from public.sms_delivery_log l
    where l.created_at::date between p_start and p_end
      and l.status <> 'skipped'
  )
  select coalesce(jsonb_agg(x order by x.day), '[]'::jsonb)
  into v_sms_daily
  from (
    select day, count(*) as messages, sum(segments) as segments, sum(cost_ugx) as cost_ugx
    from scoped group by day
  ) x;

  with scoped as (
    select l.provider, public.sms_segment_count(l.message) as segments,
           public.sms_cost_ugx(l.message, l.provider) as cost_ugx
    from public.sms_delivery_log l
    where l.created_at::date between p_start and p_end
      and l.status <> 'skipped'
  )
  select coalesce(jsonb_agg(x order by x.cost_ugx desc), '[]'::jsonb)
  into v_sms_by_provider
  from (
    select coalesce(provider, 'none') as provider,
           count(*) as messages, sum(segments) as segments, sum(cost_ugx) as cost_ugx
    from scoped group by provider
  ) x;

  with scoped as (
    select l.source, public.sms_segment_count(l.message) as segments,
           public.sms_cost_ugx(l.message, l.provider) as cost_ugx
    from public.sms_delivery_log l
    where l.created_at::date between p_start and p_end
      and l.status <> 'skipped'
  )
  select coalesce(jsonb_agg(x order by x.cost_ugx desc), '[]'::jsonb)
  into v_sms_by_source
  from (
    select coalesce(source, 'unknown') as source,
           count(*) as messages, sum(segments) as segments, sum(cost_ugx) as cost_ugx
    from scoped group by source
    order by sum(cost_ugx) desc
    limit 15
  ) x;

  -- ---- Tenant notifications: tenant_notification_log is the authoritative ----
  -- ---- source (has skip/governor visibility that sms_delivery_log's source ----
  -- ---- string and the generic by-source top-15 cut both lack). Cost is ----
  -- ---- joined via sms_log_id rather than matched by source-string prefix, ----
  -- ---- so it's exact even where an event's tag doesn't literally start ----
  -- ---- with 'tenant_notify:'. ----
  with per_event as (
    select tnl.event_key,
           count(*) filter (where tnl.status = 'sent') as sent,
           count(*) filter (where tnl.status = 'failed') as failed,
           count(*) filter (where tnl.status = 'skipped') as skipped,
           coalesce(sum(sdl.cost_ugx), 0) as cost_ugx
    from public.tenant_notification_log tnl
    left join lateral (
      select public.sms_cost_ugx(l.message, l.provider) as cost_ugx
      from public.sms_delivery_log l
      where l.id = tnl.sms_log_id
    ) sdl on true
    where tnl.created_at::date between p_start and p_end
    group by tnl.event_key
  )
  select
    jsonb_build_object(
      'sent', coalesce(sum(sent), 0), 'failed', coalesce(sum(failed), 0),
      'skipped', coalesce(sum(skipped), 0), 'cost_ugx', coalesce(sum(cost_ugx), 0)
    ),
    coalesce(jsonb_agg(jsonb_build_object(
      'event_key', event_key, 'sent', sent, 'failed', failed,
      'skipped', skipped, 'cost_ugx', cost_ugx
    ) order by cost_ugx desc), '[]'::jsonb)
  into v_tenant_totals, v_tenant_by_event
  from per_event;

  with skips as (
    select coalesce(skip_reason, 'unspecified') as skip_reason, count(*) as n
    from public.tenant_notification_log
    where created_at::date between p_start and p_end and status = 'skipped'
    group by coalesce(skip_reason, 'unspecified')
  )
  select coalesce(jsonb_agg(jsonb_build_object('skip_reason', skip_reason, 'n', n) order by n desc), '[]'::jsonb)
  into v_tenant_skip_reasons
  from skips;

  return jsonb_build_object(
    'start_date', p_start,
    'end_date', p_end,
    'generated_at', now(),
    'otp', jsonb_build_object(
      'totals', v_otp_totals,
      'by_category', v_otp_by_category,
      'daily', v_otp_daily
    ),
    'sms', jsonb_build_object(
      'totals', v_sms_totals,
      'daily', v_sms_daily,
      'by_provider', v_sms_by_provider,
      'by_source', v_sms_by_source
    ),
    'tenant_notifications', jsonb_build_object(
      'totals', v_tenant_totals,
      'by_event', v_tenant_by_event,
      'skip_reasons', v_tenant_skip_reasons
    )
  );
end;
$function$;

-- Same drift-detection coverage as the other CTO/ops RPCs
-- (project_critical_function_drift_detection): re-baseline in the SAME
-- migration whenever this function's body is deliberately changed.
INSERT INTO public.critical_function_baselines (function_signature, expected_sha256, note, baselined_at, baselined_by)
SELECT 'get_messaging_usage_weekly_bundle(date,date)',
       encode(sha256(convert_to(pg_get_functiondef('get_messaging_usage_weekly_bundle(date,date)'::regprocedure), 'UTF8')), 'hex'),
       'Feeds the weekly-messaging-usage-report email. Sums get_otp_usage_by_category(date) over the window and re-derives the SMS cost aggregation inline (does not call get_sms_cost_report, whose guard has no service_role/anon-null fallback for cron use).',
       now(),
       '20260921060000_weekly_messaging_usage_report_bundle.sql'
ON CONFLICT (function_signature) DO UPDATE
  SET expected_sha256 = EXCLUDED.expected_sha256,
      baselined_at = now(),
      baselined_by = EXCLUDED.baselined_by,
      note = EXCLUDED.note;

-- Same Wednesday-10:00-UTC (13:00 EAT) slot as the other weekly ops reports
-- (weekly-agent-ops-report, weekly-landlord-ops-report, weekly-tenant-ops-report).
-- cron.schedule() upserts by job name, so re-running this migration is safe.
-- This will 404 until weekly-messaging-usage-report is actually deployed
-- (see .github/workflows/deploy-edge-function.yml) -- same order-of-operations
-- as doc 82's get_otp_usage_by_category, where the RPC landed before the code
-- that reads it.
select cron.schedule(
  'weekly-messaging-usage-report',
  '0 10 * * 3',
  $$
  select net.http_post(
    url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/weekly-messaging-usage-report',
    headers:='{"Content-Type": "application/json", "apikey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body:=concat('{"time": "', now(), '"}')::jsonb
  ) as request_id;
  $$
);
