-- Agent assistant (read-only personal assistant) — foundation.
--
-- Three pieces:
--   1. Conversation log tables the CRM reads (assistant_conversations / _messages / _escalations).
--      Written ONLY by the agent-assistant edge function (service role). Users can read their
--      own rows; the CRM team can read all and work escalations. No client write policies.
--   2. assistant_is_agent(): the gate. Per product definition an agent is a user with a
--      record in agent_collections.
--   3. assistant_agent_* tool RPCs: read-only, STABLE, identity derived from auth.uid() and
--      NEVER a parameter, each re-checks the gate, outputs are aggregates / minimal columns.
--      The model can only reach these through the edge function's tool registry.
--
-- New functions in `public` get EXECUTE for anon by default, so every function below revokes
-- from PUBLIC/anon explicitly and grants only to authenticated (+ service_role).

-- ---------------------------------------------------------------------------
-- 1. Conversation log
-- ---------------------------------------------------------------------------
create table if not exists public.assistant_conversations (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null,
  persona          text not null default 'agent' check (persona in ('agent')),
  status           text not null default 'open' check (status in ('open', 'closed', 'escalated')),
  started_at       timestamptz not null default now(),
  last_active_at   timestamptz not null default now(),
  closed_at        timestamptz,
  escalated_at     timestamptz,
  message_count    integer not null default 0,

  -- Context captured when the conversation starts, for the CRM / fraud review.
  -- SERVER-OBSERVED (trustworthy): ip_address comes from the shared trusted-header rule
  -- (cf-connecting-ip first), user_agent and the parsed device_* fields from the request.
  ip_address       text check (char_length(ip_address) <= 64),
  user_agent       text check (char_length(user_agent) <= 512),
  device_class     text check (char_length(device_class) <= 32),
  device_browser   text check (char_length(device_browser) <= 64),
  device_os        text check (char_length(device_os) <= 64),
  -- CLIENT-REPORTED (can be spoofed; treat as a hint, never as proof): device details and GPS
  -- as the agent's browser/app reported them, only with the agent's permission.
  client_device    jsonb check (client_device is null or pg_column_size(client_device) <= 1024),
  geo_lat          numeric(9, 6) check (geo_lat between -90 and 90),
  geo_lng          numeric(9, 6) check (geo_lng between -180 and 180),
  geo_accuracy_m   numeric(10, 1) check (geo_accuracy_m >= 0),
  geo_captured_at  timestamptz,
  check ((geo_lat is null) = (geo_lng is null))
);

comment on column public.assistant_conversations.ip_address is 'Server-observed (trusted header rule).';
comment on column public.assistant_conversations.user_agent is 'Server-observed request user agent.';
comment on column public.assistant_conversations.client_device is 'CLIENT-REPORTED device details; spoofable.';
comment on column public.assistant_conversations.geo_lat is 'CLIENT-REPORTED GPS (latest in the conversation); spoofable, permission-based, may be null.';

create table if not exists public.assistant_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.assistant_conversations (id) on delete cascade,
  user_id          uuid not null,
  role             text not null check (role in ('user', 'assistant')),
  content          text not null check (char_length(content) <= 4000),
  outcome          text check (outcome in (
                     'answered', 'clarify', 'out_of_scope', 'not_an_agent',
                     'unmatched', 'rate_limited', 'blocked', 'error')),
  tools_called     text[] not null default '{}',
  model            text,
  latency_ms       integer,
  created_at       timestamptz not null default now()
);

create table if not exists public.assistant_escalations (
  id                  uuid primary key default gen_random_uuid(),
  conversation_id     uuid not null references public.assistant_conversations (id) on delete cascade,
  user_id             uuid not null,
  trigger_message_id  uuid references public.assistant_messages (id) on delete set null,
  reason              text not null check (reason in (
                        'user_requested', 'unanswered', 'out_of_scope_repeated', 'wrong_answer')),
  user_note           text check (char_length(user_note) <= 1000),
  status              text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'dismissed')),
  assigned_to         uuid,
  resolved_by         uuid,
  resolved_at         timestamptz,
  resolution_notes    text check (char_length(resolution_notes) <= 2000),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists assistant_conversations_user_idx
  on public.assistant_conversations (user_id, last_active_at desc);
create index if not exists assistant_messages_conversation_idx
  on public.assistant_messages (conversation_id, created_at);
create index if not exists assistant_messages_user_recent_idx
  on public.assistant_messages (user_id, created_at desc);
create index if not exists assistant_escalations_status_idx
  on public.assistant_escalations (status, created_at desc);

drop trigger if exists assistant_escalations_touch_updated_at on public.assistant_escalations;
create trigger assistant_escalations_touch_updated_at
  before update on public.assistant_escalations
  for each row execute function public.update_updated_at_column();

alter table public.assistant_conversations enable row level security;
alter table public.assistant_messages      enable row level security;
alter table public.assistant_escalations   enable row level security;

-- Own rows.
create policy "Users read own assistant conversations"
  on public.assistant_conversations for select to authenticated
  using (user_id = auth.uid());
create policy "Users read own assistant messages"
  on public.assistant_messages for select to authenticated
  using (user_id = auth.uid());
create policy "Users read own assistant escalations"
  on public.assistant_escalations for select to authenticated
  using (user_id = auth.uid());

-- CRM team reads everything and works escalations.
create policy "CRM team reads assistant conversations"
  on public.assistant_conversations for select to authenticated
  using (
    public.has_role(auth.uid(), 'crm'::app_role) or public.has_role(auth.uid(), 'manager'::app_role)
    or public.has_role(auth.uid(), 'coo'::app_role) or public.has_role(auth.uid(), 'ceo'::app_role)
    or public.has_role(auth.uid(), 'super_admin'::app_role)
  );
create policy "CRM team reads assistant messages"
  on public.assistant_messages for select to authenticated
  using (
    public.has_role(auth.uid(), 'crm'::app_role) or public.has_role(auth.uid(), 'manager'::app_role)
    or public.has_role(auth.uid(), 'coo'::app_role) or public.has_role(auth.uid(), 'ceo'::app_role)
    or public.has_role(auth.uid(), 'super_admin'::app_role)
  );
create policy "CRM team reads assistant escalations"
  on public.assistant_escalations for select to authenticated
  using (
    public.has_role(auth.uid(), 'crm'::app_role) or public.has_role(auth.uid(), 'manager'::app_role)
    or public.has_role(auth.uid(), 'coo'::app_role) or public.has_role(auth.uid(), 'ceo'::app_role)
    or public.has_role(auth.uid(), 'super_admin'::app_role)
  );
create policy "CRM team works assistant escalations"
  on public.assistant_escalations for update to authenticated
  using (
    public.has_role(auth.uid(), 'crm'::app_role) or public.has_role(auth.uid(), 'manager'::app_role)
    or public.has_role(auth.uid(), 'coo'::app_role) or public.has_role(auth.uid(), 'ceo'::app_role)
    or public.has_role(auth.uid(), 'super_admin'::app_role)
  )
  with check (
    public.has_role(auth.uid(), 'crm'::app_role) or public.has_role(auth.uid(), 'manager'::app_role)
    or public.has_role(auth.uid(), 'coo'::app_role) or public.has_role(auth.uid(), 'ceo'::app_role)
    or public.has_role(auth.uid(), 'super_admin'::app_role)
  );

-- No client may create, rewrite or delete log rows; the edge function (service role) is the
-- only writer. The one carve-out is the CRM working an escalation (status/assignment/notes).
revoke all on public.assistant_conversations from anon, authenticated;
revoke all on public.assistant_messages      from anon, authenticated;
revoke all on public.assistant_escalations   from anon, authenticated;
grant select on public.assistant_conversations to authenticated;
grant select on public.assistant_messages      to authenticated;
grant select on public.assistant_escalations   to authenticated;
grant update (status, assigned_to, resolved_by, resolved_at, resolution_notes)
  on public.assistant_escalations to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The gate
-- ---------------------------------------------------------------------------
create or replace function public.assistant_is_agent()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
     and exists (select 1 from public.agent_collections ac where ac.agent_id = auth.uid());
$$;

create or replace function public.assistant_require_agent()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not public.assistant_is_agent() then
    raise exception 'not_an_agent' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Tool RPCs (agent persona). Identity is auth.uid(); there is no user/agent id parameter.
-- ---------------------------------------------------------------------------

-- Wallet: the agent's own buckets. Landlord float uses the AVAILABLE figure, not the raw
-- balance (the balance still counts float already on its way back to the pool).
create or replace function public.assistant_agent_wallet()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_wallet record;
  v_has_wallet boolean;
begin
  perform public.assistant_require_agent();

  select w.balance, w.withdrawable_balance, w.float_balance, w.advance_balance,
         w.locked_balance, w.currency
    into v_wallet
    from public.wallets w
   where w.user_id = v_uid
   limit 1;
  v_has_wallet := found;

  return jsonb_build_object(
    'currency',                coalesce(v_wallet.currency, 'UGX'),
    'has_wallet',              v_has_wallet,
    'wallet_balance',          coalesce(v_wallet.balance, 0),
    'withdrawable_balance',    coalesce(v_wallet.withdrawable_balance, 0),
    'float_balance',           coalesce(v_wallet.float_balance, 0),
    'advance_balance',         coalesce(v_wallet.advance_balance, 0),
    'locked_balance',          coalesce(v_wallet.locked_balance, 0),
    'landlord_float_available', public.get_agent_lp_float_available(v_uid)
  );
end;
$$;

-- Wallet transactions: category / direction / amount / date only. Free-text descriptions are
-- deliberately omitted (they can name other people and are an injection surface).
create or replace function public.assistant_agent_wallet_transactions(
  p_from      date default null,
  p_to        date default null,
  p_direction text default null,
  p_limit     integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_today date := (now() at time zone 'Africa/Kampala')::date;
  v_from  date;
  v_to    date;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_dir   text := lower(nullif(btrim(coalesce(p_direction, '')), ''));
  v_result jsonb;
begin
  perform public.assistant_require_agent();

  v_to   := coalesce(p_to, v_today);
  v_from := coalesce(p_from, v_to - 6);
  if v_from > v_to or v_to - v_from > 92 or v_to > v_today then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if v_dir is not null and v_dir not in ('in', 'out') then
    raise exception 'invalid_direction' using errcode = '22023';
  end if;

  with rows_in_range as (
    select gl.transaction_date, gl.amount, gl.category,
           case when gl.direction in ('cash_in', 'credit') then 'in' else 'out' end as dir
      from public.general_ledger gl
     where gl.user_id = v_uid
       and gl.ledger_scope = 'wallet'
       and (gl.transaction_date at time zone 'Africa/Kampala')::date between v_from and v_to
  ),
  filtered as (
    select * from rows_in_range where v_dir is null or dir = v_dir
  )
  select jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'direction_filter', v_dir,
    'count', (select count(*) from filtered),
    'total_in',  coalesce((select sum(amount) from filtered where dir = 'in'), 0),
    'total_out', coalesce((select sum(amount) from filtered where dir = 'out'), 0),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'date', (f.transaction_date at time zone 'Africa/Kampala')::date,
               'direction', f.dir,
               'amount', f.amount,
               'category', f.category) order by f.transaction_date desc)
        from (select * from filtered order by transaction_date desc limit v_limit) f
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- Collections over a date range (Kampala days). "expected" is the pinned daily bill
-- (agent_expected_day_plans); it is compared to collections PER RENT PLAN PER DAY, never by
-- dividing the two table totals (that overstates coverage ~2x). No coverage % is returned.
create or replace function public.assistant_agent_collections_summary(
  p_from date default null,
  p_to   date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_today date := (now() at time zone 'Africa/Kampala')::date;
  v_from  date;
  v_to    date;
  v_result jsonb;
begin
  perform public.assistant_require_agent();

  v_to   := coalesce(p_to, v_today);
  v_from := coalesce(p_from, v_to);
  if v_from > v_to or v_to - v_from > 92 or v_to > v_today then
    raise exception 'invalid_range' using errcode = '22023';
  end if;

  with cash as (
    select (ac.created_at at time zone 'Africa/Kampala')::date as day,
           ac.rent_request_id, ac.tenant_id, ac.amount, ac.is_partial
      from public.agent_collections ac
     where ac.agent_id = v_uid
       and ac.reversed_at is null
       and ac.amount > 0
       and (ac.created_at at time zone 'Africa/Kampala')::date between v_from and v_to
  ),
  plans as (
    select pl.day, pl.rent_request_id, sum(pl.expected_ugx) as expected
      from public.agent_expected_day_plans pl
     where pl.agent_id = v_uid
       and pl.day between v_from and v_to
     group by pl.day, pl.rent_request_id
  ),
  cash_by_plan as (
    select day, rent_request_id, sum(amount) as paid
      from cash
     where rent_request_id is not null
     group by day, rent_request_id
  ),
  billed as (
    select p.day, p.rent_request_id, p.expected, coalesce(c.paid, 0) as paid
      from plans p
      left join cash_by_plan c on c.day = p.day and c.rent_request_id = p.rent_request_id
  ),
  by_day as (
    select day, sum(amount) as total from cash group by day
  )
  select jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'includes_today', v_to = v_today,
    'collected_total',       coalesce((select sum(amount) from cash), 0),
    'collections_count',     (select count(*) from cash),
    'tenants_paid',          (select count(distinct tenant_id) from cash),
    'partial_payments',      (select count(*) from cash where is_partial),
    'expected_due',          coalesce((select sum(expected) from billed), 0),
    'expected_basis',        'pinned_schedule',
    'collected_on_billed_plans', coalesce((select sum(paid) from billed), 0),
    'remaining_on_billed_plans', coalesce((select sum(greatest(expected - paid, 0)) from billed), 0),
    'collected_other',       coalesce((select sum(amount) from cash), 0)
                             - coalesce((select sum(paid) from billed), 0),
    'by_day', coalesce((
      select jsonb_agg(jsonb_build_object('date', day, 'collected', total) order by day)
        from by_day
       where v_to - v_from <= 30
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- One day in detail, as FACTS for explaining a high or low day. The model narrates these;
-- it does not infer causes beyond them.
create or replace function public.assistant_agent_collection_day_detail(
  p_day date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_today date := (now() at time zone 'Africa/Kampala')::date;
  v_day   date := coalesce(p_day, v_today);
  v_result jsonb;
begin
  perform public.assistant_require_agent();

  if v_day > v_today or v_today - v_day > 120 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;

  with plans as (
    select pl.rent_request_id, pl.tenant_id, sum(pl.expected_ugx) as expected
      from public.agent_expected_day_plans pl
     where pl.agent_id = v_uid and pl.day = v_day
     group by pl.rent_request_id, pl.tenant_id
  ),
  cash as (
    select ac.rent_request_id, sum(ac.amount) as paid
      from public.agent_collections ac
     where ac.agent_id = v_uid
       and ac.reversed_at is null
       and ac.amount > 0
       and (ac.created_at at time zone 'Africa/Kampala')::date = v_day
     group by ac.rent_request_id
  ),
  per_plan as (
    select p.rent_request_id, p.tenant_id, p.expected, coalesce(c.paid, 0) as paid
      from plans p
      left join cash c on c.rent_request_id = p.rent_request_id
  ),
  trail as (
    select
      coalesce((select sum(ac.amount)
                  from public.agent_collections ac
                 where ac.agent_id = v_uid and ac.reversed_at is null and ac.amount > 0
                   and (ac.created_at at time zone 'Africa/Kampala')::date between v_day - 7 and v_day - 1), 0) / 7.0 as avg_collected,
      coalesce((select sum(pl.expected_ugx)
                  from public.agent_expected_day_plans pl
                 where pl.agent_id = v_uid and pl.day between v_day - 7 and v_day - 1), 0) / 7.0 as avg_expected
  ),
  misses as (
    select jsonb_agg(m order by m.short desc) as items
      from (
        select left(regexp_replace(split_part(coalesce(pr.full_name, ''), ' ', 1), '[^A-Za-z]', '', 'g'), 20) as tenant,
               pp.expected, pp.paid, greatest(pp.expected - pp.paid, 0) as short
          from per_plan pp
          left join public.profiles pr on pr.id = pp.tenant_id
         where pp.expected > pp.paid
         order by greatest(pp.expected - pp.paid, 0) desc
         limit 5
      ) m
  )
  select jsonb_build_object(
    'day', v_day,
    'day_in_progress', v_day = v_today,
    'expected_due',     coalesce((select sum(expected) from per_plan), 0),
    'expected_basis',   'pinned_schedule',
    'collected_total',  coalesce((select sum(paid) from cash), 0),
    'collected_on_billed_plans', coalesce((select sum(paid) from per_plan), 0),
    'collected_other',  coalesce((select sum(paid) from cash), 0) - coalesce((select sum(paid) from per_plan), 0),
    'billed_plans',     (select count(*) from per_plan),
    'plans_paid_in_full', (select count(*) from per_plan where paid >= expected),
    'plans_partly_paid',  (select count(*) from per_plan where paid > 0 and paid < expected),
    'plans_unpaid',       (select count(*) from per_plan where paid = 0),
    'remaining_on_billed_plans', coalesce((select sum(greatest(expected - paid, 0)) from per_plan), 0),
    'trailing_7d_avg_collected', round((select avg_collected from trail), 0),
    'trailing_7d_avg_expected',  round((select avg_expected from trail), 0),
    'largest_shortfalls', coalesce((select items from misses), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- Tenant counts only. Linked = a rent plan assigned to / created by the agent, or a collection
-- made from them (same linkage get_agent_tenants_overview uses).
create or replace function public.assistant_agent_tenants()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_today date := (now() at time zone 'Africa/Kampala')::date;
  v_result jsonb;
begin
  perform public.assistant_require_agent();

  with linked as (
    select rr.tenant_id from public.rent_requests rr
     where rr.tenant_id is not null and (rr.agent_id = v_uid or rr.assigned_agent_id = v_uid)
    union
    select ac.tenant_id from public.agent_collections ac
     where ac.tenant_id is not null and ac.agent_id = v_uid
  ),
  active_plans as (
    select rr.id, rr.tenant_id from public.rent_requests rr
     where (rr.agent_id = v_uid or rr.assigned_agent_id = v_uid)
       and rr.tenant_id is not null
       and rr.status in ('funded', 'repaying', 'disbursed', 'active')
       and coalesce(rr.tenancy_status, 'active') <> 'ended'
  )
  select jsonb_build_object(
    'tenants_linked',              (select count(*) from linked),
    'active_rent_plans',           (select count(*) from active_plans),
    'tenants_on_active_plans',     (select count(distinct tenant_id) from active_plans),
    'tenants_billed_today',        (select count(distinct pl.tenant_id)
                                      from public.agent_expected_day_plans pl
                                     where pl.agent_id = v_uid and pl.day = v_today)
  ) into v_result;

  return v_result;
end;
$$;

-- The agent's own advances. "outstanding" = active or overdue.
create or replace function public.assistant_agent_advances(
  p_status text default 'outstanding'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_status text := lower(coalesce(nullif(btrim(p_status), ''), 'outstanding'));
  v_result jsonb;
begin
  perform public.assistant_require_agent();

  if v_status not in ('outstanding', 'all') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  with adv as (
    select a.*
      from public.agent_advances a
     where a.agent_id = v_uid
       and (v_status = 'all' or a.status in ('active', 'overdue'))
  )
  select jsonb_build_object(
    'status_filter',        v_status,
    'count',                (select count(*) from adv),
    'total_outstanding',    coalesce((select sum(outstanding_balance) from adv where status in ('active', 'overdue')), 0),
    'total_arrears',        coalesce((select sum(arrears_balance) from adv where status in ('active', 'overdue')), 0),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'status',              x.status,
               'principal',           x.principal,
               'outstanding_balance', x.outstanding_balance,
               'arrears_balance',     x.arrears_balance,
               'installment_amount',  coalesce(x.installment_amount, x.daily_installment),
               'repayment_frequency', x.repayment_frequency,
               'issued_at',           x.issued_at,
               'expires_at',          x.expires_at,
               'deduction_paused',    coalesce(x.deduction_paused, false)
             ) order by x.issued_at desc)
        from (select * from adv order by issued_at desc limit 10) x
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: authenticated + service_role only; never PUBLIC / anon.
-- ---------------------------------------------------------------------------
revoke execute on function public.assistant_is_agent() from public, anon;
grant  execute on function public.assistant_is_agent() to authenticated, service_role;

revoke execute on function public.assistant_require_agent() from public, anon, authenticated;
grant  execute on function public.assistant_require_agent() to service_role;

revoke execute on function public.assistant_agent_wallet() from public, anon;
grant  execute on function public.assistant_agent_wallet() to authenticated, service_role;

revoke execute on function public.assistant_agent_wallet_transactions(date, date, text, integer) from public, anon;
grant  execute on function public.assistant_agent_wallet_transactions(date, date, text, integer) to authenticated, service_role;

revoke execute on function public.assistant_agent_collections_summary(date, date) from public, anon;
grant  execute on function public.assistant_agent_collections_summary(date, date) to authenticated, service_role;

revoke execute on function public.assistant_agent_collection_day_detail(date) from public, anon;
grant  execute on function public.assistant_agent_collection_day_detail(date) to authenticated, service_role;

revoke execute on function public.assistant_agent_tenants() from public, anon;
grant  execute on function public.assistant_agent_tenants() to authenticated, service_role;

revoke execute on function public.assistant_agent_advances(text) from public, anon;
grant  execute on function public.assistant_agent_advances(text) to authenticated, service_role;
