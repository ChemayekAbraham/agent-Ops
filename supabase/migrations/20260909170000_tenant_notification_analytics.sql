-- Stage 5: measurement and attribution.
--
-- Before any chart: make tenant_notification_log.acted_at mean something.
-- "Sequence" (SMS then later payment) is not "causation", so this migration
-- distinguishes deterministic attribution (a link opened THROUGH the exact
-- token a specific SMS carried) from correlational attribution (a payment or
-- role change observed inside a bounded window after a send) and never
-- presents the second kind as more than that. See Part 4.

-- ---------------------------------------------------------------------------
-- Part 0: fix two role-literal bugs from Stage 3/4, caught while building
-- this stage. app_role has no 'call_centre' or 'finance' member (the real
-- values are 'crm' and 'financial_ops'), and has_role's second argument is a
-- strict enum, so the literal must resolve at parse time -- both calls would
-- have failed on every invocation, not just when that branch was reached.
-- Fixed directly in the original migration files rather than patched here,
-- since neither has ever executed against production.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Part 1: schema for attribution.
--
-- action_reference_id is deliberately untyped (no FK): "the action" can be a
-- collection row, a user_roles row, or nothing at all, depending on the
-- event, and forcing one FK target would mean fabricating a reference for
-- events that don't have one.
--
-- notification_log_id closes the loop the other direction: a dashboard link
-- now remembers which SMS send minted it, so a later open attributes back to
-- an exact row instead of "the most recent send to this tenant", which was
-- always an approximation.
-- ---------------------------------------------------------------------------
alter table public.tenant_notification_log
  add column if not exists action_reference_id uuid;

alter table public.tenant_dashboard_links
  add column if not exists notification_log_id uuid
    references public.tenant_notification_log(id);

create index if not exists idx_tenant_dashboard_links_notification_log
  on public.tenant_dashboard_links (notification_log_id)
  where notification_log_id is not null;

-- ---------------------------------------------------------------------------
-- Part 2: deterministic attribution on dashboard open.
--
-- Redefines record_tenant_dashboard_access (same signature, Stage 4) to also
-- stamp the notification log row the link was minted for -- when one exists
-- and the open is genuine engagement.
--
-- "Genuine engagement" here is device_class <> 'bot', which is a WIDER gate
-- than smartphone confirmation (device_class in ('android_phone','iphone')).
-- A tenant opening from a desktop is not smartphone evidence, but it IS a
-- real person acting on the SMS, so it counts as acted_at. Only a
-- link-preview bot's unsolicited fetch is excluded.
--
-- acted_at is set once (guarded by `is null`) -- a tenant opening the same
-- link five times attributes to the first genuine open, not the last.
-- ---------------------------------------------------------------------------
create or replace function public.record_tenant_dashboard_access(
  p_token_hash text,
  p_is_smartphone_evidence boolean default false,
  p_user_agent text default null,
  p_device_class text default null,
  p_browser text default null,
  p_os text default null,
  p_referrer text default null,
  p_ip_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.tenant_dashboard_links;
  v_first boolean := false;
  v_confirmed boolean := false;
  v_prev_status text;
  v_genuine boolean;
begin
  select * into v_link
  from public.tenant_dashboard_links
  where token_hash = p_token_hash;

  if not found
     or v_link.revoked_at is not null
     or (v_link.expires_at is not null and v_link.expires_at < now()) then
    return jsonb_build_object('valid', false);
  end if;

  v_genuine := coalesce(p_device_class, '') <> 'bot';

  select smartphone_status into v_prev_status
  from public.profiles where id = v_link.tenant_id;

  v_first := not exists (
    select 1 from public.tenant_dashboard_access_log
    where tenant_id = v_link.tenant_id
  );

  update public.tenant_dashboard_links
  set last_used_at = now(), use_count = use_count + 1
  where id = v_link.id;

  update public.profiles
  set dashboard_first_access_at = coalesce(dashboard_first_access_at, now()),
      dashboard_last_access_at = now(),
      dashboard_access_count = dashboard_access_count + 1,
      dashboard_activated = true,
      smartphone_status = case
        when p_is_smartphone_evidence then 'CONFIRMED_SMARTPHONE'
        else smartphone_status end,
      smartphone_source = case
        when p_is_smartphone_evidence then 'DASHBOARD_ACCESS'
        else smartphone_source end,
      smartphone_verified_at = case
        when p_is_smartphone_evidence then now()
        else smartphone_verified_at end
  where id = v_link.tenant_id;

  v_confirmed := p_is_smartphone_evidence;

  insert into public.tenant_dashboard_access_log (
    tenant_id, link_id, user_agent, device_class, browser, os,
    referrer, ip_hash, counted_as_smartphone, was_first_access
  ) values (
    v_link.tenant_id, v_link.id, p_user_agent, p_device_class, p_browser, p_os,
    p_referrer, p_ip_hash, v_confirmed, v_first
  );

  -- Deterministic attribution: this open traces back to the exact SMS that
  -- minted the link, not a heuristic "most recent send".
  if v_genuine and v_link.notification_log_id is not null then
    update public.tenant_notification_log
    set acted_at = now(),
        action = 'dashboard_opened',
        action_reference_id = v_link.id
    where id = v_link.notification_log_id
      and acted_at is null;
  end if;

  return jsonb_build_object(
    'valid', true,
    'tenant_id', v_link.tenant_id,
    'first_access', v_first,
    'smartphone_confirmed', v_confirmed,
    'previous_status', v_prev_status
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Part 3: mint the link with its notification_log_id.
--
-- Callers cannot pass this at issue time -- the log row for the SMS that will
-- carry the token doesn't exist until AFTER the token and link are created
-- (the message body needs the token first). So this is a second, narrow
-- write: "this link belongs to this send", called once the send completes.
-- ---------------------------------------------------------------------------
create or replace function public.attach_notification_to_dashboard_link(
  p_link_id uuid,
  p_notification_log_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  update public.tenant_dashboard_links
  set notification_log_id = p_notification_log_id
  where id = p_link_id and notification_log_id is null;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function public.attach_notification_to_dashboard_link(uuid, uuid) from public;
grant execute on function public.attach_notification_to_dashboard_link(uuid, uuid)
  to service_role, postgres;

-- ---------------------------------------------------------------------------
-- Part 4: correlational attribution sweeps.
--
-- These are the two events where "the action" is not an open of a tracked
-- link, so there is no deterministic path. Both are bounded-window
-- observations, not causal claims -- reported as "payment after reminder" /
-- "became agent after opportunity SMS", never "caused by".
--
-- 4a. MERCHANT_CODE_REMINDER -> payment. A qualifying payment is an
--     agent_collections row for the same tenant, amount > 0, not reversed
--     (a reversal only appends "[REVERSED: ...]" to notes -- amount is
--     untouched -- so that filter is required, not optional; see the
--     welile-expected-vs-collected skill), inside the window after the send.
-- 4b. FIVE_DAY_AGENT_OPPORTUNITY -> became an agent. A user_roles row for
--     'agent' or 'sub_agent', enabled, created strictly after the send --
--     "created after" rather than "exists", so a tenant who was already
--     somehow agent-flagged before the SMS does not count as a conversion.
--     No upper bound on this one: registering as an agent is not instant, and
--     capping it at the same 24h window as a MoMo payment would undercount.
--
-- Idempotent and cheap to re-run: only unattributed (acted_at is null) rows
-- within the lookback are scanned, and the acted_at is null guard on write
-- means a row is claimed by at most one match.
-- ---------------------------------------------------------------------------
create or replace function public.attribute_tenant_notification_actions(
  p_lookback_days int default 14,
  p_merchant_window_hours int default 24
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_attributed int := 0;
  v_agent_attributed int := 0;
begin
  with candidates as (
    select l.id, l.tenant_id, l.created_at
    from public.tenant_notification_log l
    where l.event_key = 'MERCHANT_CODE_REMINDER'
      and l.status = 'sent'
      and l.acted_at is null
      and l.created_at >= now() - make_interval(days => greatest(p_lookback_days, 1))
  ),
  matched as (
    select distinct on (c.id)
      c.id as log_id, ac.id as collection_id, ac.created_at as paid_at
    from candidates c
    join public.agent_collections ac
      on ac.tenant_id = c.tenant_id
     and ac.amount > 0
     and coalesce(ac.notes, '') not ilike '%[REVERSED:%'
     and ac.created_at >= c.created_at
     and ac.created_at <  c.created_at + make_interval(hours => greatest(p_merchant_window_hours, 1))
    order by c.id, ac.created_at asc
  )
  update public.tenant_notification_log l
  set acted_at = m.paid_at,
      action = 'payment_after_reminder',
      action_reference_id = m.collection_id
  from matched m
  where l.id = m.log_id
    and l.acted_at is null;
  get diagnostics v_merchant_attributed = row_count;

  with candidates as (
    select l.id, l.tenant_id, l.created_at
    from public.tenant_notification_log l
    where l.event_key = 'FIVE_DAY_AGENT_OPPORTUNITY'
      and l.status = 'sent'
      and l.acted_at is null
      and l.created_at >= now() - make_interval(days => greatest(p_lookback_days, 1))
  ),
  matched as (
    select distinct on (c.id)
      c.id as log_id, ur.id as role_id, ur.created_at as became_agent_at
    from candidates c
    join public.user_roles ur
      on ur.user_id = c.tenant_id
     and ur.role in ('agent', 'sub_agent')
     and ur.enabled = true
     and ur.created_at > c.created_at
    order by c.id, ur.created_at asc
  )
  update public.tenant_notification_log l
  set acted_at = m.became_agent_at,
      action = 'became_agent_after_opportunity',
      action_reference_id = m.role_id
  from matched m
  where l.id = m.log_id
    and l.acted_at is null;
  get diagnostics v_agent_attributed = row_count;

  return jsonb_build_object(
    'merchant_code_conversions', v_merchant_attributed,
    'agent_opportunity_conversions', v_agent_attributed,
    'lookback_days', p_lookback_days,
    'merchant_window_hours', p_merchant_window_hours
  );
end;
$$;

revoke all on function public.attribute_tenant_notification_actions(int, int) from public;
grant execute on function public.attribute_tenant_notification_actions(int, int)
  to service_role, postgres;

-- ---------------------------------------------------------------------------
-- Part 5: indexes for the reporting queries below and in 5J.
-- ---------------------------------------------------------------------------
create index if not exists idx_tenant_notification_log_tenant_event_created
  on public.tenant_notification_log (tenant_id, event_key, created_at desc);

create index if not exists idx_tenant_notification_log_acted_at
  on public.tenant_notification_log (acted_at)
  where acted_at is not null;

create index if not exists idx_tenant_notification_log_sms_log
  on public.tenant_notification_log (sms_log_id)
  where sms_log_id is not null;

create index if not exists idx_profiles_district
  on public.profiles (district)
  where deleted_at is null and district is not null;

-- ---------------------------------------------------------------------------
-- Part 6: smartphone + dashboard overview (5D/5E/5F combined).
--
-- One aggregated call, matching the "small set of aggregated results, not
-- N+1 or client-side aggregation" rule (5J). SQL aggregation only -- no row
-- set is returned for the frontend to reduce.
--
-- p_district / p_agent_id are the two filters implemented now. Agent is
-- resolved through the tenant's currently active Rent Plan, since
-- tenant_notification_log and profiles carry no agent_id of their own; a
-- tenant with no active plan is excluded when p_agent_id is supplied (there
-- is no agent to filter by) but included in the unfiltered overview.
-- ---------------------------------------------------------------------------
create or replace function public.get_tenant_smartphone_overview(
  p_district text default null,
  p_agent_id uuid default null
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

  with tenant_agent as (
    select distinct on (e.tenant_id) e.tenant_id, e.agent_id
    from public.v_tenant_daily_eligibility e
    where e.status in ('funded','disbursed','repaying')
    order by e.tenant_id, e.start_at desc
  ),
  scoped as (
    select p.id, p.smartphone_status, p.smartphone_source, p.dashboard_activated,
           p.dashboard_first_access_at, p.dashboard_last_access_at, p.dashboard_access_count
    from public.profiles p
    join public.user_roles ur on ur.user_id = p.id and ur.role = 'tenant' and ur.enabled
    left join tenant_agent ta on ta.tenant_id = p.id
    where p.deleted_at is null
      and (p_district is null or p.district = p_district)
      and (p_agent_id is null or ta.agent_id = p_agent_id)
  )
  select jsonb_build_object(
    'active_tenants', count(*),
    'device', jsonb_build_object(
      'confirmed_smartphone', count(*) filter (where smartphone_status = 'CONFIRMED_SMARTPHONE'),
      'confirmed_feature_phone', count(*) filter (where smartphone_status = 'CONFIRMED_FEATURE_PHONE'),
      'unknown', count(*) filter (where smartphone_status = 'UNKNOWN')
    ),
    'source', jsonb_build_object(
      'onboarding', count(*) filter (where smartphone_source = 'ONBOARDING'),
      'call_centre', count(*) filter (where smartphone_source = 'CALL_CENTER'),
      'dashboard_access', count(*) filter (where smartphone_source = 'DASHBOARD_ACCESS'),
      'agent', count(*) filter (where smartphone_source = 'AGENT'),
      'system_detection', count(*) filter (where smartphone_source = 'SYSTEM_DETECTION'),
      'unresolved', count(*) filter (where smartphone_status = 'UNKNOWN')
    ),
    'dashboard', jsonb_build_object(
      'activated', count(*) filter (where dashboard_activated),
      'never_activated', count(*) filter (where not dashboard_activated),
      'smartphone_and_activated', count(*) filter (
        where smartphone_status = 'CONFIRMED_SMARTPHONE' and dashboard_activated
      ),
      'smartphone_not_activated', count(*) filter (
        where smartphone_status = 'CONFIRMED_SMARTPHONE' and not dashboard_activated
      ),
      'activation_rate_pct', case
        when count(*) filter (where smartphone_status = 'CONFIRMED_SMARTPHONE') = 0 then 0
        else round(
          100.0 * count(*) filter (
            where smartphone_status = 'CONFIRMED_SMARTPHONE' and dashboard_activated
          ) / count(*) filter (where smartphone_status = 'CONFIRMED_SMARTPHONE'),
          1
        )
      end,
      'opened_once', count(*) filter (where dashboard_access_count = 1),
      'opened_2_plus', count(*) filter (where dashboard_access_count >= 2),
      'opened_last_7d', count(*) filter (
        where dashboard_last_access_at >= now() - interval '7 days'
      ),
      'opened_last_30d', count(*) filter (
        where dashboard_last_access_at >= now() - interval '30 days'
      )
    ),
    'filters', jsonb_build_object('district', p_district, 'agent_id', p_agent_id),
    'generated_at', now()
  )
  into v_result
  from scoped;

  return coalesce(v_result, jsonb_build_object('active_tenants', 0, 'generated_at', now()));
end;
$$;

revoke all on function public.get_tenant_smartphone_overview(text, uuid) from public;
grant execute on function public.get_tenant_smartphone_overview(text, uuid) to authenticated;
grant execute on function public.get_tenant_smartphone_overview(text, uuid) to service_role, postgres;

-- ---------------------------------------------------------------------------
-- Part 7: notification performance (5G).
--
-- "delivered" is read from sms_delivery_log.status = 'delivered', which is
-- only populated by Africa's Talking's delivery-report callback
-- (sms-delivery-report). Other providers (Yoola, LANA) do not confirm
-- handset delivery, so their rows stay at 'sent' (accepted by the provider)
-- and are counted as sent, not delivered -- the figure therefore
-- undercounts true delivery for non-AT sends rather than overclaiming it.
--
-- conversion_rate_pct is "sent AND later acted", worded as such rather than
-- "converted", per the causation warning in Part 4.
-- ---------------------------------------------------------------------------
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
    select l.*, sd.status as sms_status
    from public.tenant_notification_log l
    left join public.sms_delivery_log sd on sd.id = l.sms_log_id
    left join public.profiles p on p.id = l.tenant_id
    where l.created_at::date between p_start and p_end
      and (p_event_key is null or l.event_key = p_event_key)
      and (p_district is null or p.district = p_district)
  )
  select jsonb_build_object(
    'sent', count(*) filter (where status = 'sent'),
    'delivered', count(*) filter (where status = 'sent' and sms_status = 'delivered'),
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
    select l.*, sd.status as sms_status
    from public.tenant_notification_log l
    left join public.sms_delivery_log sd on sd.id = l.sms_log_id
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
      count(*) filter (where status = 'sent' and sms_status = 'delivered') as delivered,
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

revoke all on function public.get_tenant_notification_performance(date, date, text, text) from public;
grant execute on function public.get_tenant_notification_performance(date, date, text, text) to authenticated;
grant execute on function public.get_tenant_notification_performance(date, date, text, text) to service_role, postgres;
