-- Stage 6: multi-channel routing (SMS / push / in-app).
--
-- CORRECTION before anything else: this codebase has no Firebase/FCM. Push is
-- already a complete, working VAPID Web Push implementation --
-- push_subscriptions (endpoint/p256dh/auth), full RFC 8291/8188 encryption in
-- send-push-notification, a registered /sw.js, and an existing UI trigger
-- (PushNotificationButton.tsx). There is also already a generic in-app inbox
-- (notifications: user_id/title/message/type/metadata/is_read), already
-- written to by several other edge functions. Building tenant_push_devices,
-- an FCM sender, and tenant_in_app_notifications as new parallel systems
-- would be exactly the "two independent copies of the same fact" trap this
-- codebase has been bitten by before (merchant OOP settlement, missed-days
-- functions). So Stage 6 EXTENDS both tables additively rather than
-- replacing them, and reuses the existing VAPID crypto rather than adding a
-- Firebase dependency that doesn't exist anywhere in this project.
--
-- What's genuinely new here (no pre-existing equivalent):
--   tenant_notification_channel_policy  -- which channels an event may use
--   tenant_notification_deliveries      -- per-channel push/in-app attempts
--   tenant_notification_preferences     -- the tenant's own marketing toggle
--   four push/in-app template columns on tenant_notification_events

-- ---------------------------------------------------------------------------
-- Part 1: extend push_subscriptions (existing, live table -- additive only,
-- no RLS change, no constraint change). device_class/browser/os reuse the
-- Stage 4 classifier so a push device gets the same device intelligence a
-- dashboard-link open already gets, rather than a second UA-parsing path.
-- last_seen_at lets a future report show "opened in last 7d" for push the
-- same way dashboard_last_access_at does for the dashboard link.
--
-- Deliberately NOT adding a permission_status/revoked_at state machine: the
-- existing model's lifecycle is already "row exists = subscribed, row
-- deleted = gone" (send-push-notification deletes on a 404/410 "permanently
-- gone" response; PushNotificationButton.tsx deletes on explicit revoke).
-- Adding a parallel soft-revoke flag that the existing cleanup path never
-- sets would create two competing answers to "is this device dead".
-- ---------------------------------------------------------------------------
alter table public.push_subscriptions
  add column if not exists device_class text,
  add column if not exists browser text,
  add column if not exists os text,
  add column if not exists last_seen_at timestamptz;

-- ---------------------------------------------------------------------------
-- Part 2: extend notifications (existing, live table -- additive only). This
-- becomes the tenant in-app inbox by reusing the exact table other functions
-- already write staff/tenant notices into, rather than a parallel
-- tenant_in_app_notifications table with its own RLS to get right.
--
-- read_at is added ALONGSIDE the existing is_read boolean rather than instead
-- of it -- a trigger keeps them in sync in both directions -- so no existing
-- reader of is_read has to change, while new analytics get a precise "when".
-- ---------------------------------------------------------------------------
alter table public.notifications
  add column if not exists event_key text,
  add column if not exists link_path text,
  add column if not exists notification_log_id uuid,
  add column if not exists dismissed_at timestamptz,
  add column if not exists read_at timestamptz,
  add column if not exists expires_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'notifications_notification_log_id_fkey'
  ) then
    alter table public.notifications
      add constraint notifications_notification_log_id_fkey
      foreign key (notification_log_id) references public.tenant_notification_log(id);
  end if;
end $$;

create index if not exists idx_notifications_notification_log_id
  on public.notifications (notification_log_id)
  where notification_log_id is not null;

create index if not exists idx_notifications_event_key
  on public.notifications (user_id, event_key, created_at desc)
  where event_key is not null;

create or replace function public.sync_notification_read_state()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if NEW.is_read is true and OLD.is_read is not true and NEW.read_at is null then
    NEW.read_at := now();
  elsif NEW.read_at is not null and OLD.read_at is null then
    NEW.is_read := true;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_sync_notification_read_state on public.notifications;

create trigger trg_sync_notification_read_state
  before update on public.notifications
  for each row
  execute function public.sync_notification_read_state();

-- ---------------------------------------------------------------------------
-- Part 3: channel policy.
--
-- push_preferred is the mechanism behind "conditional" SMS in the brief's
-- policy table: when true AND the tenant has at least one active push
-- subscription AND push_enabled, the router sends push+in-app and does NOT
-- also send SMS for that event -- this is what stops every engagement event
-- from silently costing SMS money once a tenant has push. When false, SMS
-- and push both fire independently per their own enabled flags (the
-- deliberate double-delivery the brief's PAYMENT_MISSED example shows).
--
-- critical marks financial/contractual events: SMS is attempted regardless
-- of push_preferred/push availability, and (Stage 6L) a tenant's marketing
-- opt-out must never suppress a critical event's push/in-app either.
--
-- sms_fallback only matters for a push_preferred (non-critical) event: if
-- every active device's push attempt fails synchronously (Web Push carries
-- no async delivery-failure callback the way Africa's Talking's DLR does, so
-- failure is known immediately, not later), send SMS once as a safety net.
-- Left false for pure proposition copy so a bad push token can't silently
-- turn every engagement send back into an SMS and erase the cost advantage
-- push exists for.
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_notification_channel_policy (
  event_key text primary key references public.tenant_notification_events(event_key) on update cascade,
  sms_enabled boolean not null default true,
  push_enabled boolean not null default false,
  in_app_enabled boolean not null default false,
  push_preferred boolean not null default false,
  sms_fallback boolean not null default false,
  critical boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.tenant_notification_channel_policy
  (event_key, sms_enabled, push_enabled, in_app_enabled, push_preferred, sms_fallback, critical) values
  -- Financial/critical: every channel fires, always, independent of push
  -- availability. These affect money, balances and obligations -- see the
  -- Stage 6F "do not migrate these fully off SMS yet" instruction.
  ('PAYMENT_FULL',                  true, true, true, false, false, true),
  ('PAYMENT_PARTIAL',               true, true, true, false, false, true),
  ('PAYMENT_MISSED',                true, true, true, false, false, true),
  ('RENT_LIMIT_INCREASED',          true, true, true, false, false, true),
  ('MERCHANT_CODE_REMINDER',        true, true, true, false, false, true),
  -- Five-day default is transactional (Stage 1) and carries real business
  -- stakes for a defaulting tenant, so it keeps the same always-fire
  -- treatment as the financial group despite being a proposition in tone.
  ('FIVE_DAY_AGENT_OPPORTUNITY',    true, true, true, false, false, true),
  -- Engagement/proposition: prefer push+in-app once a tenant has an active
  -- device; SMS is the reach channel only for tenants push cannot reach yet.
  ('TENANT_RELOCATION',             true, true, true, true,  false, false),
  ('RENT_LIMIT_PROGRESS',           true, true, true, true,  false, false),
  -- Fires the instant a tenant first proves smartphone capability by opening
  -- the dashboard -- they very likely have no push token yet on THIS visit,
  -- so SMS is worth a one-time fallback if push has nothing to attempt.
  ('DASHBOARD_ACTIVATED',           true, true, true, true,  true,  false),
  -- These exist BECAUSE the tenant has no confirmed device yet or has never
  -- opened the dashboard -- push/in-app are definitionally unusable for them.
  ('DASHBOARD_INVITE',              true, false, false, false, false, false),
  ('SMARTPHONE_DISCOVERY',          true, false, false, false, false, false),
  -- By definition targets tenants with NO active push token (Stage 6K) --
  -- push cannot be attempted. In-app is available for once they do open the
  -- app, so a first visit still surfaces the nudge.
  ('PUSH_MIGRATION',                true, false, true, false, false, false)
on conflict (event_key) do nothing;

alter table public.tenant_notification_channel_policy enable row level security;

create policy "tenant_notification_channel_policy_ops_read"
  on public.tenant_notification_channel_policy for select
  using (
    public.has_role(auth.uid(),'tenant_ops') or public.has_role(auth.uid(),'super_admin')
    or public.has_role(auth.uid(),'manager') or public.has_role(auth.uid(),'coo')
    or public.has_role(auth.uid(),'ceo') or public.has_role(auth.uid(),'cfo')
    or public.has_role(auth.uid(),'operations') or public.has_role(auth.uid(),'agent_ops')
  );

create policy "tenant_notification_channel_policy_ops_write"
  on public.tenant_notification_channel_policy for update
  using (
    public.has_role(auth.uid(),'tenant_ops') or public.has_role(auth.uid(),'super_admin')
    or public.has_role(auth.uid(),'coo') or public.has_role(auth.uid(),'ceo')
  )
  with check (
    public.has_role(auth.uid(),'tenant_ops') or public.has_role(auth.uid(),'super_admin')
    or public.has_role(auth.uid(),'coo') or public.has_role(auth.uid(),'ceo')
  );

-- Service role reads it on every routed send.
grant select on public.tenant_notification_channel_policy to service_role;

-- ---------------------------------------------------------------------------
-- Part 4: per-channel delivery attempts.
--
-- SMS deliberately does NOT get a row here -- tenant_notification_log +
-- sms_delivery_log already are that record, and writing a synthetic 'sms'
-- row here would be exactly the duplicated-fact problem this migration's
-- preamble describes. Reporting unions the two at query time instead (Part
-- 8). This table exists only for the two channels that had no prior record:
-- push (one row per device attempted) and in-app (one row per inbox entry).
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_log_id uuid not null references public.tenant_notification_log(id),
  channel text not null check (channel in ('push', 'in_app')),
  provider text,
  status text not null default 'attempted'
    check (status in ('attempted', 'sent', 'delivered', 'opened', 'failed')),
  push_subscription_id uuid references public.push_subscriptions(id),
  in_app_notification_id uuid references public.notifications(id),
  provider_message_id text,
  error_code text,
  error text,
  attempted_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_tenant_notification_deliveries_log
  on public.tenant_notification_deliveries (notification_log_id);

create index if not exists idx_tenant_notification_deliveries_channel_created
  on public.tenant_notification_deliveries (channel, created_at desc);

alter table public.tenant_notification_deliveries enable row level security;

create policy "tenant_notification_deliveries_ops_read"
  on public.tenant_notification_deliveries for select
  using (
    public.has_role(auth.uid(),'tenant_ops') or public.has_role(auth.uid(),'super_admin')
    or public.has_role(auth.uid(),'manager') or public.has_role(auth.uid(),'coo')
    or public.has_role(auth.uid(),'ceo') or public.has_role(auth.uid(),'cfo')
    or public.has_role(auth.uid(),'operations') or public.has_role(auth.uid(),'agent_ops')
  );

revoke insert, update, delete on public.tenant_notification_deliveries from authenticated;

-- ---------------------------------------------------------------------------
-- Part 5: per-tenant preference.
--
-- Deliberately ONE toggle, not four. The brief's 6L mock shows four switches
-- (push overall, payment updates, rent access updates, opportunities), but
-- payment/rent-limit-increase are both `critical = true` in the policy table
-- above and Stage 6L is explicit that critical/contractual communication
-- must not become suppressible just because promotional push is off. A
-- switch that LOOKS like it controls "payment updates" but is silently
-- ignored for critical events is worse than not offering it, so only the
-- genuinely optional category -- marketing/proposition push+in-app -- is
-- exposed. marketing_push_opt_out never touches SMS; SMS opt-out is the
-- existing, separate sms_opt_outs table.
--
-- RLS follows push_subscriptions' own convention for this table family:
-- direct self-service access (auth.uid() = tenant_id), not an RPC layer --
-- this is a preference, not money.
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_notification_preferences (
  tenant_id uuid primary key references public.profiles(id),
  push_enabled boolean not null default true,
  marketing_push_opt_out boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.tenant_notification_preferences enable row level security;

create policy "tenant_notification_preferences_self_select"
  on public.tenant_notification_preferences for select
  using (auth.uid() = tenant_id);

create policy "tenant_notification_preferences_self_upsert"
  on public.tenant_notification_preferences for insert
  with check (auth.uid() = tenant_id);

create policy "tenant_notification_preferences_self_update"
  on public.tenant_notification_preferences for update
  using (auth.uid() = tenant_id)
  with check (auth.uid() = tenant_id);

grant select on public.tenant_notification_preferences to service_role;

-- ---------------------------------------------------------------------------
-- Part 6: push/in-app copy on the existing catalogue (Stage 6I). SMS stays
-- shorter than these, deliberately -- every SMS character costs money, push
-- and in-app do not.
-- ---------------------------------------------------------------------------
alter table public.tenant_notification_events
  add column if not exists push_title_template text,
  add column if not exists push_body_template text,
  add column if not exists in_app_title_template text,
  add column if not exists in_app_body_template text;

update public.tenant_notification_events set
  push_title_template = t.push_title, push_body_template = t.push_body,
  in_app_title_template = t.in_app_title, in_app_body_template = t.in_app_body
from (values
  ('PAYMENT_FULL',
   'Payment received', 'Welile received {{amount_paid}}. Today''s rent obligation is cleared.',
   'Payment received', 'Welile received {{amount_paid}}. Your remaining balance is {{balance}}.'),
  ('PAYMENT_PARTIAL',
   'Partial payment received', 'We received {{amount_paid}}. {{remaining_balance}} remains due today.',
   'Partial payment received', 'We received {{amount_paid}} of {{amount_due}} due today. {{remaining_balance}} carries forward. Balance: {{balance}}.'),
  ('PAYMENT_MISSED',
   'Rent payment pending', 'Today''s {{amount_due}} remains unpaid and has carried forward.',
   'Rent payment pending', 'Today''s {{amount_due}} rent was not received and has carried forward. Balance: {{balance}}.'),
  ('FIVE_DAY_AGENT_OPPORTUNITY',
   'Earn with Welile', 'You can become a Welile Agent and earn by helping others access Welile services.',
   'Earn with Welile', 'You can become a Welile Agent and earn income by helping people in your area access Welile services.'),
  ('TENANT_RELOCATION',
   'Need to move?', 'Welile can support you when shifting to another home.',
   'Need to move?', 'Welile can continue supporting your rent even if you move. Inform your agent and help arrange a replacement tenant for your current house.'),
  ('RENT_LIMIT_INCREASED',
   'Your rent access increased', 'Your new Welile rent access is {{new_limit}}.',
   'Your rent access increased', 'Your good payment record has increased your Welile rent access to {{new_limit}}. Keep paying consistently to grow it further.'),
  ('RENT_LIMIT_PROGRESS',
   'Keep building your rent record', 'Consistent rent payments strengthen your Welile financial record.',
   'Keep building your rent record', 'Every on-time rent payment strengthens your record and helps you qualify for a higher Welile rent access.'),
  ('MERCHANT_CODE_REMINDER',
   'Pay Welile directly', 'You don''t have to wait for your agent -- pay Welile directly using {{pay_channels}}.',
   'Pay Welile directly', 'You don''t have to wait for your agent. Pay Welile directly using {{pay_channels}}. Your agent relationship remains recognised.'),
  ('DASHBOARD_ACTIVATED',
   'Welcome to your dashboard', 'Track your rent payments, balance and available services anytime.',
   'Welcome to your dashboard', 'You can now track your rent payments, balances and available services anytime, right here.'),
  -- No push copy: push_enabled is false for this event by definition (Stage
  -- 6K targets tenants with NO push token, so a push message could never
  -- reach them). In-app is the once-they-do-open-the-app nudge.
  ('PUSH_MIGRATION',
   null, null,
   'Turn on notifications', 'Get faster payment updates and account information. Turn on notifications in your device settings.')
) as t(event_key, push_title, push_body, in_app_title, in_app_body)
where public.tenant_notification_events.event_key = t.event_key;

-- ---------------------------------------------------------------------------
-- Part 7: RPCs the router and inbox UI call.
-- ---------------------------------------------------------------------------

-- "Active" mirrors the existing model exactly: row exists = subscribed. See
-- Part 1's comment on why no separate status field was added.
create or replace function public.get_tenant_active_push_subscriptions(p_tenant_id uuid)
returns table (id uuid, endpoint text, p256dh text, auth text)
language sql
stable
security definer
set search_path = public
as $$
  select ps.id, ps.endpoint, ps.p256dh, ps.auth
  from public.push_subscriptions ps
  where ps.user_id = p_tenant_id;
$$;

revoke all on function public.get_tenant_active_push_subscriptions(uuid) from public;
grant execute on function public.get_tenant_active_push_subscriptions(uuid)
  to service_role, postgres;

-- One row per device attempted for one logical event. Service-role only: the
-- frontend never writes delivery/notification state directly, the same rule
-- CLAUDE.md states for ledger writes, applied here by extension.
create or replace function public.record_push_delivery(
  p_notification_log_id uuid,
  p_push_subscription_id uuid,
  p_status text,
  p_provider_message_id text default null,
  p_error_code text default null,
  p_error text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.tenant_notification_deliveries (
    notification_log_id, channel, provider, status, push_subscription_id,
    provider_message_id, error_code, error,
    sent_at, failed_at
  ) values (
    p_notification_log_id, 'push', 'webpush', p_status, p_push_subscription_id,
    p_provider_message_id, p_error_code, p_error,
    case when p_status = 'sent' then now() else null end,
    case when p_status = 'failed' then now() else null end
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.record_push_delivery(uuid, uuid, text, text, text, text) from public;
grant execute on function public.record_push_delivery(uuid, uuid, text, text, text, text)
  to service_role, postgres;

-- Writes the inbox row AND its delivery record together, so the two can
-- never disagree about whether an in-app notification was actually created.
create or replace function public.create_tenant_in_app_notification(
  p_notification_log_id uuid,
  p_tenant_id uuid,
  p_event_key text,
  p_title text,
  p_body text,
  p_link_path text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_notification_id uuid;
begin
  insert into public.notifications (
    user_id, title, message, type, metadata,
    event_key, link_path, notification_log_id, expires_at
  ) values (
    p_tenant_id, p_title, p_body, 'tenant_notification', coalesce(p_metadata, '{}'::jsonb),
    p_event_key, p_link_path, p_notification_log_id, p_expires_at
  )
  returning id into v_notification_id;

  insert into public.tenant_notification_deliveries (
    notification_log_id, channel, provider, status,
    in_app_notification_id, sent_at
  ) values (
    p_notification_log_id, 'in_app', 'inbox', 'sent',
    v_notification_id, now()
  );

  return v_notification_id;
end;
$$;

revoke all on function public.create_tenant_in_app_notification(uuid, uuid, text, text, text, text, jsonb, timestamptz) from public;
grant execute on function public.create_tenant_in_app_notification(uuid, uuid, text, text, text, text, jsonb, timestamptz)
  to service_role, postgres;

-- Tenant-facing: marks BOTH the inbox row and its delivery record. A tenant
-- could already UPDATE their own `notifications` row directly (the existing
-- RLS policy permits it), but that cannot also touch
-- tenant_notification_deliveries, which carries no tenant-facing RLS at all
-- -- so this RPC is what keeps the two in sync, not a policy requirement.
create or replace function public.mark_in_app_notification_read(p_notification_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  select user_id into v_owner from public.notifications where id = p_notification_id;
  if v_owner is null or v_owner <> auth.uid() then
    return false;
  end if;

  update public.notifications
  set is_read = true, read_at = coalesce(read_at, now())
  where id = p_notification_id;

  update public.tenant_notification_deliveries
  set status = 'opened', opened_at = coalesce(opened_at, now())
  where in_app_notification_id = p_notification_id
    and status <> 'opened';

  return true;
end;
$$;

revoke all on function public.mark_in_app_notification_read(uuid) from public;
grant execute on function public.mark_in_app_notification_read(uuid) to authenticated;
grant execute on function public.mark_in_app_notification_read(uuid) to service_role, postgres;

create or replace function public.dismiss_in_app_notification(p_notification_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  select user_id into v_owner from public.notifications where id = p_notification_id;
  if v_owner is null or v_owner <> auth.uid() then
    return false;
  end if;

  update public.notifications
  set dismissed_at = coalesce(dismissed_at, now())
  where id = p_notification_id;

  return true;
end;
$$;

revoke all on function public.dismiss_in_app_notification(uuid) from public;
grant execute on function public.dismiss_in_app_notification(uuid) to authenticated;
grant execute on function public.dismiss_in_app_notification(uuid) to service_role, postgres;

-- ---------------------------------------------------------------------------
-- Part 8: Stage 5 analytics extension by channel (6M).
--
-- Unions SMS facts (already recorded in tenant_notification_log /
-- sms_delivery_log -- see get_tenant_notification_performance) with push/
-- in-app facts (tenant_notification_deliveries) at READ time, rather than
-- ever writing an SMS row into tenant_notification_deliveries -- one send is
-- one logical event; this answers "how did it go per channel" without ever
-- claiming three notifications where the tenant received one. See 6N.
-- ---------------------------------------------------------------------------
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
           count(*) filter (where l.status = 'sent' and sd.status = 'delivered') as delivered,
           count(*) filter (where l.status = 'failed') as failed,
           count(*) filter (where l.status = 'sent' and l.acted_at is not null) as opened_or_acted
    from public.tenant_notification_log l
    left join public.sms_delivery_log sd on sd.id = l.sms_log_id
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

revoke all on function public.get_tenant_channel_performance(date, date, text) from public;
grant execute on function public.get_tenant_channel_performance(date, date, text) to authenticated;
grant execute on function public.get_tenant_channel_performance(date, date, text) to service_role, postgres;

-- ---------------------------------------------------------------------------
-- Part 9: PUSH_MIGRATION candidates (Stage 6K).
--
-- Deliberately narrow, per the brief: CONFIRMED_SMARTPHONE, dashboard
-- already activated, and NO active push subscription. Explicitly excludes
-- feature-phone and UNKNOWN tenants (push cannot help them), dashboard-
-- inactive tenants (they have not proven they can even reach the dashboard
-- yet -- Stage 4F/4G's discovery/invite events are for them), and anyone who
-- already has a push device (they need no migration).
-- ---------------------------------------------------------------------------
create or replace function public.get_tenant_push_migration_candidates(
  p_limit int default 2000
)
returns table (
  tenant_id uuid,
  tenant_name text,
  tenant_phone text
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id as tenant_id, p.full_name as tenant_name, p.phone as tenant_phone
  from public.profiles p
  join public.user_roles ur on ur.user_id = p.id and ur.role = 'tenant' and ur.enabled
  where p.deleted_at is null
    and coalesce(p.phone, '') <> ''
    and p.smartphone_status = 'CONFIRMED_SMARTPHONE'
    and p.dashboard_activated = true
    and not exists (
      select 1 from public.push_subscriptions ps where ps.user_id = p.id
    )
  order by p.id
  limit greatest(1, least(coalesce(p_limit, 2000), 5000));
$$;

revoke all on function public.get_tenant_push_migration_candidates(int) from public;
grant execute on function public.get_tenant_push_migration_candidates(int)
  to authenticated, service_role, postgres;
