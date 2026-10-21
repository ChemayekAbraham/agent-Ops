-- Neexa inbox mirror: a local copy of the conversations Neexa's AI agent has with customers
-- (WhatsApp, email, Facebook, Instagram, website chat) for the CMO dashboard.
--
-- Writers (service role only, never the browser):
--   neexa-webhook  inbound customer messages (messages:<channel>) and replies made outside
--                  our API, such as AI auto-replies or the Neexa dashboard (message_echoes:<channel>)
--   neexa-api      the staff proxy. Records what staff send and what it reads back from
--                  Neexa (conversation lists, message history).
-- Readers: enabled cmo, super_admin, cto roles (can_view_neexa_inbox), matching the
-- /cmo/dashboard RoleGuard.
--
-- Neexa ids are kept as text. The API returns them as strings and its retries can
-- deliver the same message more than once, so message id is the primary key and
-- every write is an upsert.
--
-- No money moves here. Additive only.

create table if not exists public.neexa_conversations (
  id                    text primary key,
  platform              text,
  title                 text,
  label                 text,
  sentiment             text,
  description           text,
  customer_address      text,
  platform_id           text,
  last_message_at       timestamptz,
  last_message_preview  text,
  last_inbound_at       timestamptz,
  neexa_created_at      timestamptz,
  neexa_updated_at      timestamptz,
  details_synced_at     timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists neexa_conversations_last_message_at_idx
  on public.neexa_conversations (last_message_at desc nulls last);
create index if not exists neexa_conversations_customer_address_idx
  on public.neexa_conversations (customer_address);

create table if not exists public.neexa_messages (
  id                    text primary key,
  conversation_id       text not null references public.neexa_conversations(id) on delete cascade,
  direction             text not null check (direction in ('inbound','outbound')),
  -- customer = inbound webhook, echo = reply made outside our API (AI, Neexa dashboard,
  -- WhatsApp Business App), api = sent by our staff through neexa-api, sync = read back from Neexa
  source                text not null check (source in ('customer','echo','api','sync')),
  creator_type          text,
  channel               text,
  body                  text,
  status                text,
  message_type          text,
  platform_message_id   text,
  platform_id           text,
  customer_address      text,
  template_public_id    text,
  sent_by               uuid references auth.users(id) on delete set null,
  sent_at               timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists neexa_messages_conversation_sent_idx
  on public.neexa_messages (conversation_id, sent_at desc);

-- Verified webhook deliveries, kept for debugging and replay. Rejected deliveries are not
-- stored, so an unsigned caller cannot fill this table.
create table if not exists public.neexa_webhook_events (
  id            bigint generated always as identity primary key,
  event         text not null,
  message_id    text,
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  error         text
);

create index if not exists neexa_webhook_events_received_at_idx
  on public.neexa_webhook_events (received_at desc);

-- ---------------------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------------------
-- No service-role shortcut here. The neexa-api proxy calls this with the service-role
-- client and the signed-in staff id, so the answer must depend on _uid alone.
-- (The service role bypasses RLS anyway.)
create or replace function public.can_view_neexa_inbox(_uid uuid)
 returns boolean language sql stable security definer set search_path to 'public'
as $f$
  select _uid is not null and exists (
    select 1 from public.user_roles ur
     where ur.user_id = _uid and ur.enabled = true
       and ur.role in ('cmo','super_admin','cto'));
$f$;
revoke all on function public.can_view_neexa_inbox(uuid) from public, anon;
grant execute on function public.can_view_neexa_inbox(uuid) to authenticated, service_role;

alter table public.neexa_conversations  enable row level security;
alter table public.neexa_messages       enable row level security;
alter table public.neexa_webhook_events enable row level security;

drop policy if exists neexa_conversations_staff_read on public.neexa_conversations;
create policy neexa_conversations_staff_read on public.neexa_conversations
  for select to authenticated using (public.can_view_neexa_inbox(auth.uid()));

drop policy if exists neexa_messages_staff_read on public.neexa_messages;
create policy neexa_messages_staff_read on public.neexa_messages
  for select to authenticated using (public.can_view_neexa_inbox(auth.uid()));

-- neexa_webhook_events has no policy: service role only.

revoke all on public.neexa_conversations, public.neexa_messages, public.neexa_webhook_events from anon;
revoke insert, update, delete, truncate on public.neexa_conversations, public.neexa_messages from authenticated;
revoke all on public.neexa_webhook_events from authenticated;

-- ---------------------------------------------------------------------------------------
-- Ingest: one atomic upsert of a message and its conversation summary.
-- ---------------------------------------------------------------------------------------
-- Deliveries can arrive late, twice, or out of order, so the conversation's last-message
-- fields only move forward and a re-delivered message never downgrades a known status or
-- loses the staff member who sent it.
create or replace function public.neexa_ingest_message(
  _message_id          text,
  _conversation_id     text,
  _direction           text,
  _source              text,
  _body                text,
  _sent_at             timestamptz,
  _channel             text default null,
  _creator_type        text default null,
  _status              text default null,
  _message_type        text default null,
  _platform_message_id text default null,
  _platform_id         text default null,
  _customer_address    text default null,
  _template_public_id  text default null,
  _sent_by             uuid default null
) returns void language plpgsql security definer set search_path to 'public'
as $f$
declare
  v_at timestamptz := coalesce(_sent_at, now());
begin
  insert into public.neexa_conversations as c (
    id, platform, customer_address, platform_id,
    last_message_at, last_message_preview, last_inbound_at)
  values (
    _conversation_id, _channel, _customer_address, _platform_id,
    v_at, left(_body, 280), case when _direction = 'inbound' then v_at end)
  on conflict (id) do update set
    platform         = coalesce(c.platform, excluded.platform),
    customer_address = coalesce(c.customer_address, excluded.customer_address),
    platform_id      = coalesce(c.platform_id, excluded.platform_id),
    last_message_preview = case when c.last_message_at is null or excluded.last_message_at >= c.last_message_at
                                then excluded.last_message_preview else c.last_message_preview end,
    last_message_at  = greatest(c.last_message_at, excluded.last_message_at),
    last_inbound_at  = greatest(c.last_inbound_at, excluded.last_inbound_at),
    updated_at       = now();

  insert into public.neexa_messages as m (
    id, conversation_id, direction, source, creator_type, channel, body, status, message_type,
    platform_message_id, platform_id, customer_address, template_public_id, sent_by, sent_at)
  values (
    _message_id, _conversation_id, _direction, _source, _creator_type, _channel, _body, _status, _message_type,
    _platform_message_id, _platform_id, _customer_address, _template_public_id, _sent_by, v_at)
  on conflict (id) do update set
    -- A message first recorded by our own send (api) or the webhook keeps that source;
    -- a later read-back (sync) only fills gaps and refreshes delivery status.
    source              = case when m.source = 'sync' then excluded.source else m.source end,
    creator_type        = coalesce(excluded.creator_type, m.creator_type),
    channel             = coalesce(m.channel, excluded.channel),
    body                = coalesce(m.body, excluded.body),
    status              = coalesce(excluded.status, m.status),
    message_type        = coalesce(m.message_type, excluded.message_type),
    platform_message_id = coalesce(m.platform_message_id, excluded.platform_message_id),
    platform_id         = coalesce(m.platform_id, excluded.platform_id),
    customer_address    = coalesce(m.customer_address, excluded.customer_address),
    template_public_id  = coalesce(m.template_public_id, excluded.template_public_id),
    sent_by             = coalesce(m.sent_by, excluded.sent_by),
    sent_at             = coalesce(m.sent_at, excluded.sent_at),
    updated_at          = now();
end;
$f$;
revoke all on function public.neexa_ingest_message(text,text,text,text,text,timestamptz,text,text,text,text,text,text,text,text,uuid)
  from public, anon, authenticated;
grant execute on function public.neexa_ingest_message(text,text,text,text,text,timestamptz,text,text,text,text,text,text,text,text,uuid)
  to service_role;

-- Live updates for the CMO inbox. Realtime applies the select policies above.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'neexa_conversations') then
    alter publication supabase_realtime add table public.neexa_conversations;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'neexa_messages') then
    alter publication supabase_realtime add table public.neexa_messages;
  end if;
end $$;
