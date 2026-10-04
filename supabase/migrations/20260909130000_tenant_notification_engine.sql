-- Tenant notification engine (2026-09-06 + 2026-09-09 tenant-ops meetings).
--
-- Turns tenant SMS from scheduled bulk messaging into a behaviour-driven
-- notification engine. This migration is deliberately ONLY the engine: the
-- event catalog, the send log (episode idempotency + conversion tracking),
-- the frequency governor, and real consecutive-missed-day detection.
-- Individual senders are separate edge functions that call in.
--
-- Reconciles the "daily SMS" vs "twice per week" tension from the two
-- meetings by classifying every event:
--   * transactional -- event-driven, may fire daily (payment received,
--     partial payment, missed payment, fifth missed day)
--   * marketing     -- value-proposition copy, globally capped at twice per
--     rolling 7 days (relocation, rent-access progress, dashboard link)
--
-- Reuses existing infrastructure rather than duplicating it:
--   * delivery status, opt-out gating and provider fallback stay in
--     sms_delivery_log + _shared/sendSmsMultiProvider.ts (which already
--     gates on sms_opt_outs and sms_message_exceptions)
--   * consecutive-run detection is derived FROM get_tenant_missed_dates
--     rather than re-deriving "what counts as a missed day". This codebase
--     has already been burned by two independent copies of the same rule
--     drifting apart, so there stays exactly one definition of a missed day.

-- ---------------------------------------------------------------------------
-- Tunable settings. Single row -- ops can retune the marketing cap without a
-- deploy, matching how tenant_message_templates lets copy be edited in place.
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_notification_settings (
  id int primary key default 1 check (id = 1),
  marketing_max_per_week int not null default 2 check (marketing_max_per_week >= 0),
  default_episode_window_days int not null default 30
    check (default_episode_window_days between 7 and 180),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

insert into public.tenant_notification_settings (id) values (1)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Event catalog. Adding an event is a data change, not a schema change.
-- max_per_week / max_per_day are per-event caps applied ON TOP of the global
-- marketing cap; null means "no per-event cap".
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_notification_events (
  event_key text primary key,
  label text not null,
  message_class text not null check (message_class in ('transactional','marketing')),
  max_per_week int check (max_per_week is null or max_per_week >= 0),
  max_per_day int check (max_per_day is null or max_per_day >= 0),
  active boolean not null default true,
  -- SPA path the SMS should point at, resolved against the deploy origin at
  -- send time. Kept as data so ops can repoint a campaign, and so a sender
  -- never hardcodes a route that does not exist yet.
  link_path text,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Older deployments of this table predate link_path.
alter table public.tenant_notification_events
  add column if not exists link_path text;

insert into public.tenant_notification_events
  (event_key, label, message_class, max_per_week, max_per_day, link_path, description) values
  ('payment_received', 'Payment received', 'transactional', null, null, null,
   'Tenant payment recorded. Confirms amount and that the daily obligation cleared.'),
  ('payment_partial', 'Partial payment', 'transactional', null, null, null,
   'Payment landed below the daily amount due. States received, remaining, and that the balance carries forward.'),
  ('payment_missed', 'Missed payment', 'transactional', null, 1, null,
   'A daily obligation closed unpaid. Episode key is the obligation date so it fires once for that day.'),
  ('default_5day_agent_opportunity', '5-day default -- agent opportunity', 'transactional', null, null,
   '/agent-commission-benefits',
   'Five consecutive missed days. Offers Welile agent earnings. Once per default episode, never daily after day five. link_path points at the existing agent-earnings explainer until a dedicated tenant-to-agent conversion page exists.'),
  ('rent_access_progress', 'Rent access progress', 'marketing', 1, 1, null,
   'Repayment behaviour changed the tenant Rent Plan limit.'),
  ('relocation_proposition', 'Relocation / house shifting', 'marketing', 2, 1, null,
   'Tenant proposition: Welile keeps supporting rent through a move. Not conditional on defaulting.'),
  ('merchant_code_payment', 'Merchant-code payment', 'transactional', null, 1, null,
   'Tenant has an unpaid amount and no agent available -- how to pay Welile directly.'),
  ('dashboard_link', 'Dashboard access link', 'marketing', 1, 1, null,
   'Secure dashboard link for smartphone-capable tenants. Repeats until the link is opened. Uses a per-tenant token, not link_path.')
on conflict (event_key) do nothing;

alter table public.tenant_notification_events enable row level security;
alter table public.tenant_notification_settings enable row level security;

create policy "tenant_notification_events_ops_read"
  on public.tenant_notification_events for select
  using (
    public.has_role(auth.uid(),'tenant_ops') or public.has_role(auth.uid(),'super_admin')
    or public.has_role(auth.uid(),'manager') or public.has_role(auth.uid(),'coo')
    or public.has_role(auth.uid(),'ceo') or public.has_role(auth.uid(),'cfo')
    or public.has_role(auth.uid(),'operations') or public.has_role(auth.uid(),'agent_ops')
  );

create policy "tenant_notification_events_ops_write"
  on public.tenant_notification_events for update
  using (
    public.has_role(auth.uid(),'tenant_ops') or public.has_role(auth.uid(),'super_admin')
    or public.has_role(auth.uid(),'coo') or public.has_role(auth.uid(),'ceo')
  )
  with check (
    public.has_role(auth.uid(),'tenant_ops') or public.has_role(auth.uid(),'super_admin')
    or public.has_role(auth.uid(),'coo') or public.has_role(auth.uid(),'ceo')
  );

create policy "tenant_notification_settings_ops_read"
  on public.tenant_notification_settings for select
  using (
    public.has_role(auth.uid(),'tenant_ops') or public.has_role(auth.uid(),'super_admin')
    or public.has_role(auth.uid(),'manager') or public.has_role(auth.uid(),'coo')
    or public.has_role(auth.uid(),'ceo') or public.has_role(auth.uid(),'cfo')
  );

create policy "tenant_notification_settings_ops_write"
  on public.tenant_notification_settings for update
  using (
    public.has_role(auth.uid(),'tenant_ops') or public.has_role(auth.uid(),'super_admin')
    or public.has_role(auth.uid(),'coo') or public.has_role(auth.uid(),'ceo')
  )
  with check (
    public.has_role(auth.uid(),'tenant_ops') or public.has_role(auth.uid(),'super_admin')
    or public.has_role(auth.uid(),'coo') or public.has_role(auth.uid(),'ceo')
  );

-- ---------------------------------------------------------------------------
-- Send log. Two jobs:
--   1. idempotency -- (tenant, event, episode) is unique for successful sends,
--      so a cron double-fire or a manual re-invoke cannot duplicate an SMS
--   2. conversion measurement -- acted_at/action answer "what happened AFTER
--      the SMS" (links opened, agent applications started), which is what the
--      meetings actually asked for rather than "SMS sent"
-- sms_log_id points at the existing sms_delivery_log row, so delivery status
-- is never duplicated here -- it is joined.
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_notification_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.profiles(id),
  event_key text not null references public.tenant_notification_events(event_key),
  episode_key text,
  channel text not null default 'sms' check (channel in ('sms','push','in_app')),
  phone text,
  status text not null default 'sent' check (status in ('sent','failed','skipped')),
  skip_reason text,
  provider text,
  sms_log_id uuid references public.sms_delivery_log(id),
  payload jsonb not null default '{}'::jsonb,
  acted_at timestamptz,
  action text,
  created_at timestamptz not null default now()
);

-- Only successful sends occupy the idempotency slot: a failed or skipped
-- attempt must not block a later retry of the same episode.
create unique index if not exists uq_tenant_notification_log_episode
  on public.tenant_notification_log (tenant_id, event_key, episode_key)
  where episode_key is not null and status = 'sent';

create index if not exists idx_tenant_notification_log_tenant_created
  on public.tenant_notification_log (tenant_id, created_at desc);

create index if not exists idx_tenant_notification_log_event_created
  on public.tenant_notification_log (event_key, created_at desc);

alter table public.tenant_notification_log enable row level security;

create policy "tenant_notification_log_ops_read"
  on public.tenant_notification_log for select
  using (
    public.has_role(auth.uid(),'tenant_ops') or public.has_role(auth.uid(),'super_admin')
    or public.has_role(auth.uid(),'manager') or public.has_role(auth.uid(),'coo')
    or public.has_role(auth.uid(),'ceo') or public.has_role(auth.uid(),'cfo')
    or public.has_role(auth.uid(),'operations') or public.has_role(auth.uid(),'agent_ops')
  );

-- Only the edge functions (service role) write log rows.
revoke insert, update, delete on public.tenant_notification_log from authenticated;

-- ---------------------------------------------------------------------------
-- Consecutive missed days.
--
-- get_tenant_missed_days already exists but counts missed days ANYWHERE in a
-- window, so a tenant who missed Mon/Wed/Fri scores 3 -- it cannot answer
-- "five days in a row". get_tenant_repayment_reliability's missed_days is a
-- different thing again (expected_days - paid_days, derived from amounts, not
-- calendar days). Neither can drive the five-day rule.
--
-- This walks BACKWARDS from p_as_of over the missed-date array returned by
-- get_tenant_missed_dates, so the definition of "missed" stays in one place.
--
-- p_as_of defaults to YESTERDAY in Africa/Kampala: today is still in progress,
-- and a tenant who simply has not paid yet this morning is not in default for
-- today. Anchoring on the last complete day is what stops the five-day SMS
-- from firing a day early.
-- ---------------------------------------------------------------------------
create or replace function public.get_tenant_consecutive_missed_days(
  p_window_days int default 30,
  p_as_of date default ((now() at time zone 'Africa/Kampala')::date - 1)
)
returns table (
  tenant_id uuid,
  consecutive_missed_days int,
  run_start_date date,
  run_end_date date,
  episode_key text
)
language sql
stable
security definer
set search_path = public
as $$
  with src as (
    select m.tenant_id, m.missed_dates
    from public.get_tenant_missed_dates(greatest(p_window_days, 1), p_as_of) m
  ),
  -- Walk back from p_as_of; the run length is the offset of the first day
  -- that was NOT missed. If every day in the window was missed the run is
  -- the whole window (the caller only needs to know it is >= 5).
  runs as (
    select s.tenant_id,
           coalesce(
             min(g.offset_days) filter (
               where not ((p_as_of - g.offset_days) = any (s.missed_dates))
             ),
             greatest(p_window_days, 1)
           )::int as run_len
    from src s
    cross join generate_series(0, greatest(p_window_days, 1) - 1) as g(offset_days)
    group by s.tenant_id
  )
  select r.tenant_id,
         r.run_len as consecutive_missed_days,
         (p_as_of - (r.run_len - 1)) as run_start_date,
         p_as_of as run_end_date,
         'default:' || (p_as_of - (r.run_len - 1))::text as episode_key
  from runs r
  where r.run_len > 0;
$$;

revoke all on function public.get_tenant_consecutive_missed_days(int, date) from public;
grant execute on function public.get_tenant_consecutive_missed_days(int, date)
  to authenticated, service_role, postgres;

-- ---------------------------------------------------------------------------
-- Five-day default candidates.
--
-- Wraps the raw consecutive-run primitive with the two guards that keep the
-- agent-opportunity SMS honest. Measured against production on 2026-09-09,
-- an unguarded five-day rule would have messaged 744 tenants with a missed
-- day, 558 of them at five days or more -- but only 38 were genuine fresh
-- defaults (run 5-6, average 4 days since last payment). The other ~520 were
-- stale: 351 had missed the entire 30-day window, averaging 37 days since any
-- payment, and 57 of those had never paid anything at all.
--
--   p_max_run  -- a tenant 30 days into default must not receive a message
--                that says "5 days"; it is untrue and reads as broken.
--   p_episode_start_on_or_after -- launch guard. Pass the engine go-live date
--                on first run so only episodes that BEGIN under the engine are
--                messaged, instead of blasting every historical default at
--                once. Null disables the guard.
-- ---------------------------------------------------------------------------
create or replace function public.get_tenant_five_day_default_candidates(
  p_as_of date default ((now() at time zone 'Africa/Kampala')::date - 1),
  p_min_run int default 5,
  p_max_run int default 7,
  p_episode_start_on_or_after date default null,
  p_window_days int default 30
)
returns table (
  tenant_id uuid,
  tenant_name text,
  tenant_phone text,
  consecutive_missed_days int,
  run_start_date date,
  episode_key text,
  outstanding numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select c.tenant_id,
         p.full_name as tenant_name,
         p.phone as tenant_phone,
         c.consecutive_missed_days,
         c.run_start_date,
         c.episode_key,
         greatest(0, coalesce(o.outstanding, 0))::numeric as outstanding
  from public.get_tenant_consecutive_missed_days(p_window_days, p_as_of) c
  join public.profiles p on p.id = c.tenant_id
  left join (
    select e.tenant_id,
           max(coalesce(e.total_repayment,0) - coalesce(e.amount_repaid,0)) as outstanding
    from public.v_tenant_daily_eligibility e
    group by e.tenant_id
  ) o on o.tenant_id = c.tenant_id
  where c.consecutive_missed_days >= greatest(coalesce(p_min_run, 5), 1)
    and (p_max_run is null or c.consecutive_missed_days <= p_max_run)
    and (
      p_episode_start_on_or_after is null
      or c.run_start_date >= p_episode_start_on_or_after
    )
    and p.deleted_at is null
    and coalesce(p.phone, '') <> '';
$$;

revoke all on function public.get_tenant_five_day_default_candidates(date, int, int, date, int) from public;
grant execute on function public.get_tenant_five_day_default_candidates(date, int, int, date, int)
  to authenticated, service_role, postgres;

-- ---------------------------------------------------------------------------
-- Frequency governor.
--
-- Answers "may I send this event to this tenant right now?". Deliberately
-- does NOT check opt-outs or blocked numbers -- sendSmsMultiProvider already
-- gates on sms_opt_outs and sms_message_exceptions for every send path, and
-- a second copy of that check is exactly the kind of drift this codebase has
-- been bitten by before.
--
-- Returns jsonb so callers get a machine-readable reason for the skip, which
-- is what gets written to tenant_notification_log.skip_reason.
-- ---------------------------------------------------------------------------
create or replace function public.can_send_tenant_notification(
  p_tenant_id uuid,
  p_event_key text,
  p_episode_key text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_event public.tenant_notification_events;
  v_marketing_cap int;
  v_sent_today int;
  v_sent_week int;
  v_marketing_week int;
begin
  select * into v_event
  from public.tenant_notification_events
  where event_key = p_event_key;

  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'unknown_event');
  end if;

  if not v_event.active then
    return jsonb_build_object('allowed', false, 'reason', 'event_inactive');
  end if;

  -- Once per episode. This is what stops the five-day agent-opportunity SMS
  -- from repeating every day after day five.
  if p_episode_key is not null then
    if exists (
      select 1 from public.tenant_notification_log
      where tenant_id = p_tenant_id
        and event_key = p_event_key
        and episode_key = p_episode_key
        and status = 'sent'
    ) then
      return jsonb_build_object('allowed', false, 'reason', 'already_sent_this_episode');
    end if;
  end if;

  select count(*) into v_sent_today
  from public.tenant_notification_log
  where tenant_id = p_tenant_id
    and event_key = p_event_key
    and status = 'sent'
    and (created_at at time zone 'Africa/Kampala')::date
        = (now() at time zone 'Africa/Kampala')::date;

  if v_event.max_per_day is not null and v_sent_today >= v_event.max_per_day then
    return jsonb_build_object(
      'allowed', false, 'reason', 'event_daily_cap',
      'sent_today', v_sent_today, 'cap', v_event.max_per_day
    );
  end if;

  select count(*) into v_sent_week
  from public.tenant_notification_log
  where tenant_id = p_tenant_id
    and event_key = p_event_key
    and status = 'sent'
    and created_at >= now() - interval '7 days';

  if v_event.max_per_week is not null and v_sent_week >= v_event.max_per_week then
    return jsonb_build_object(
      'allowed', false, 'reason', 'event_weekly_cap',
      'sent_week', v_sent_week, 'cap', v_event.max_per_week
    );
  end if;

  -- Global marketing cap: the meetings' "maximum twice per week" applies
  -- across ALL value-proposition copy combined, not per event -- otherwise
  -- eight marketing events at twice each is sixteen SMS a week.
  if v_event.message_class = 'marketing' then
    select marketing_max_per_week into v_marketing_cap
    from public.tenant_notification_settings where id = 1;

    v_marketing_cap := coalesce(v_marketing_cap, 2);

    select count(*) into v_marketing_week
    from public.tenant_notification_log l
    join public.tenant_notification_events e on e.event_key = l.event_key
    where l.tenant_id = p_tenant_id
      and l.status = 'sent'
      and e.message_class = 'marketing'
      and l.created_at >= now() - interval '7 days';

    if v_marketing_week >= v_marketing_cap then
      return jsonb_build_object(
        'allowed', false, 'reason', 'marketing_weekly_cap',
        'sent_week', v_marketing_week, 'cap', v_marketing_cap
      );
    end if;
  end if;

  return jsonb_build_object(
    'allowed', true,
    'message_class', v_event.message_class,
    'reason', null
  );
end;
$$;

revoke all on function public.can_send_tenant_notification(uuid, text, text) from public;
grant execute on function public.can_send_tenant_notification(uuid, text, text)
  to service_role, postgres;

-- ---------------------------------------------------------------------------
-- Log writer. Service-role only: the frontend never writes notification state
-- directly, same rule as ledger/wallet writes.
--
-- Returns null when the unique episode index rejects a duplicate, so a racing
-- second invocation can tell it lost without raising.
-- ---------------------------------------------------------------------------
create or replace function public.record_tenant_notification(
  p_tenant_id uuid,
  p_event_key text,
  p_episode_key text default null,
  p_channel text default 'sms',
  p_phone text default null,
  p_status text default 'sent',
  p_skip_reason text default null,
  p_provider text default null,
  p_sms_log_id uuid default null,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.tenant_notification_log (
    tenant_id, event_key, episode_key, channel, phone,
    status, skip_reason, provider, sms_log_id, payload
  ) values (
    p_tenant_id, p_event_key, p_episode_key, p_channel, p_phone,
    p_status, p_skip_reason, p_provider, p_sms_log_id, coalesce(p_payload, '{}'::jsonb)
  )
  on conflict do nothing
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.record_tenant_notification(uuid, text, text, text, text, text, text, text, uuid, jsonb) from public;
grant execute on function public.record_tenant_notification(uuid, text, text, text, text, text, text, text, uuid, jsonb)
  to service_role, postgres;

-- ---------------------------------------------------------------------------
-- Conversion marker: records that the tenant DID something after an SMS.
-- Stamps the most recent sent notification of that event for the tenant.
-- ---------------------------------------------------------------------------
create or replace function public.mark_tenant_notification_action(
  p_tenant_id uuid,
  p_event_key text,
  p_action text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  update public.tenant_notification_log
  set acted_at = coalesce(acted_at, now()),
      action = coalesce(action, p_action)
  where id = (
    select id from public.tenant_notification_log
    where tenant_id = p_tenant_id
      and event_key = p_event_key
      and status = 'sent'
    order by created_at desc
    limit 1
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.mark_tenant_notification_action(uuid, text, text) from public;
grant execute on function public.mark_tenant_notification_action(uuid, text, text)
  to service_role, postgres;
