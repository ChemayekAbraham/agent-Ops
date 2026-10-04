-- Formal SMS catalogue alignment + Stage 3 supporting schema.
--
-- Brings the engine's event catalog onto the formal event keys, moves SMS copy
-- into editable templates, and adds the three things Stage 3 needs that did
-- not exist: merchant-code configuration, rent-limit change history, and the
-- candidate selectors for relocation / rent-limit / merchant-code sends.
--
-- Governing rule, applied throughout: business logic determines the event and
-- the SMS engine only communicates what the system already knows to be true.
-- Balances come from the obligation state, limits from the limit engine,
-- merchant codes from configuration. No sender computes any of them.

-- ---------------------------------------------------------------------------
-- Part 1: event keys and copy.
--
-- Keys move to the formal UPPER_SNAKE catalogue. The FK from the send log
-- gains ON UPDATE CASCADE first so the rename cannot orphan log rows -- the
-- log is empty today, but a rename that only works while a table is empty is
-- a trap for whoever renames the next one.
--
-- Copy moves into body_template so Tenant Ops can edit wording without a
-- deploy, matching how tenant_message_templates already works. Placeholders
-- use {{double_brace}} for consistency with that table (the catalogue drafts
-- were written with single braces).
-- ---------------------------------------------------------------------------
alter table public.tenant_notification_events
  add column if not exists body_template text;

alter table public.tenant_notification_log
  drop constraint if exists tenant_notification_log_event_key_fkey;

alter table public.tenant_notification_log
  add constraint tenant_notification_log_event_key_fkey
  foreign key (event_key) references public.tenant_notification_events(event_key)
  on update cascade;

update public.tenant_notification_events set event_key = 'PAYMENT_FULL'               where event_key = 'payment_received';
update public.tenant_notification_events set event_key = 'PAYMENT_PARTIAL'            where event_key = 'payment_partial';
update public.tenant_notification_events set event_key = 'PAYMENT_MISSED'             where event_key = 'payment_missed';
update public.tenant_notification_events set event_key = 'FIVE_DAY_AGENT_OPPORTUNITY' where event_key = 'default_5day_agent_opportunity';
update public.tenant_notification_events set event_key = 'RENT_LIMIT_PROGRESS'        where event_key = 'rent_access_progress';
update public.tenant_notification_events set event_key = 'TENANT_RELOCATION'          where event_key = 'relocation_proposition';
update public.tenant_notification_events set event_key = 'MERCHANT_CODE_REMINDER'     where event_key = 'merchant_code_payment';
update public.tenant_notification_events set event_key = 'DASHBOARD_INVITE'           where event_key = 'dashboard_link';

-- Events that had no catalog row yet.
insert into public.tenant_notification_events
  (event_key, label, message_class, max_per_week, max_per_day, link_path, description) values
  ('RENT_LIMIT_INCREASED', 'Rent access limit increased', 'transactional', null, 1, null,
   'Fires only when the limit engine actually raised total_limit. Driven by credit_limit_change_log, never inferred from a payment.'),
  ('SMARTPHONE_DISCOVERY', 'Smartphone discovery', 'marketing', 1, 1, null,
   'Sent to tenants whose smartphone status is UNKNOWN. Opening the link from a mobile browser is evidence of smartphone access.'),
  ('DASHBOARD_ACTIVATED', 'Dashboard activated', 'transactional', null, 1, null,
   'Welcome message after the first verified tenant dashboard session. Fires once, ever.'),
  ('PUSH_MIGRATION', 'Push notifications enabled', 'transactional', null, 1, null,
   'Push token registered. Confirms app notifications are active and that critical notices may still arrive by SMS.')
on conflict (event_key) do nothing;

-- Copy, from the formal catalogue. Regulatory terminology enforced:
-- "Rent Plan" / "rent access", never "loan"; "Returns", never interest or ROI.
update public.tenant_notification_events set body_template = t.body
from (values
  ('PAYMENT_FULL',
   'Welile: We received {{amount_paid}}. Today''s rent obligation is fully cleared. Your balance is {{balance}}.{{dashboard_suffix}}'),
  ('PAYMENT_PARTIAL',
   'Welile: We received {{amount_paid}}. Today''s due was {{amount_due}}. {{remaining_balance}} remains and will carry forward.{{dashboard_suffix}}'),
  -- {{pay_direct}} and {{agent_cta}} are whole optional sentences, not bare
  -- values: an absent merchant code or link must remove the sentence, not
  -- leave "Pay directly via MTN or Airtel." or a dangling "Start here".
  ('PAYMENT_MISSED',
   'Welile: Today''s {{amount_due}} rent payment was not received. It remains due and carries forward.{{pay_direct}}'),
  ('FIVE_DAY_AGENT_OPPORTUNITY',
   'Need another source of income? You can become a Welile Agent and earn by helping people access Welile services.{{agent_cta}}'),
  ('TENANT_RELOCATION',
   'Need to shift? Welile can support you to move to another home. Inform Welile or your agent and help arrange a new tenant for your current house.'),
  ('RENT_LIMIT_INCREASED',
   'Welile: Your good payment record has increased your rent access to {{new_limit}}. Keep paying consistently to grow your access.{{dashboard_suffix}}'),
  ('RENT_LIMIT_PROGRESS',
   'Welile: Every good rent payment strengthens your record and helps you qualify for higher rent access.{{dashboard_suffix}}'),
  ('MERCHANT_CODE_REMINDER',
   'You don''t have to wait for your agent. Pay Welile directly using {{pay_channels}}. Your agent relationship remains recognised.'),
  ('DASHBOARD_INVITE',
   'Welile: Your tenant dashboard is ready. See your payments, balance and rent access anytime from your smartphone: {{dashboard_link}}'),
  ('SMARTPHONE_DISCOVERY',
   'Welile: If you use a smartphone, open your personal tenant dashboard here to see your rent payments and balance: {{dashboard_link}}'),
  ('DASHBOARD_ACTIVATED',
   'Welcome to your Welile dashboard. You can now track your rent payments, balances and available services anytime: {{dashboard_link}}'),
  -- Corrected in Stage 6: the original draft here said notifications were
  -- ALREADY on, but PUSH_MIGRATION's actual trigger (Stage 6K) is a confirmed
  -- smartphone tenant with an active dashboard and NO push token yet — the
  -- point of the message is to invite them to turn notifications on, not
  -- confirm they already did.
  ('PUSH_MIGRATION',
   'Welile: Turn on notifications from your tenant dashboard to receive faster payment updates and account information. Open: {{dashboard_link}}')
) as t(event_key, body)
where public.tenant_notification_events.event_key = t.event_key
  and public.tenant_notification_events.body_template is null;

-- ---------------------------------------------------------------------------
-- Part 2: payment channel configuration.
--
-- Merchant codes are currently hardcoded in src/components/payments/
-- DepositFlow.tsx (MTN 090777, Airtel 4380664). Seeded from those values so
-- there is a single source, and so a code change is a data change rather than
-- a frontend deploy plus an SMS-template edit that can silently disagree.
-- ---------------------------------------------------------------------------
create table if not exists public.payment_channels (
  id uuid primary key default gen_random_uuid(),
  provider text not null unique check (provider in ('mtn','airtel','bank')),
  display_name text not null,
  merchant_code text not null,
  merchant_name text,
  active boolean not null default true,
  sort_order int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

insert into public.payment_channels (provider, display_name, merchant_code, merchant_name, sort_order) values
  ('mtn', 'MTN MoMo', '090777', 'WELILE TECHNOLOGIES LIMITTED', 1),
  ('airtel', 'Airtel Money', '4380664', 'WELILE TECHNOLOGIES LIMITTED', 2)
on conflict (provider) do nothing;

alter table public.payment_channels enable row level security;

-- Merchant codes are public payment instructions, not secrets: any signed-in
-- user may read them, only finance/ops may change them.
create policy "payment_channels_read_all"
  on public.payment_channels for select
  to authenticated
  using (true);

create policy "payment_channels_ops_write"
  on public.payment_channels for update
  using (
    public.has_role(auth.uid(),'super_admin') or public.has_role(auth.uid(),'cfo')
    or public.has_role(auth.uid(),'coo') or public.has_role(auth.uid(),'ceo')
    -- app_role has no 'finance' member; the finance role in this codebase is
    -- 'financial_ops' (see the financial_ops enum value / financial-ops-daily
    -- naming elsewhere). The bare literal would fail every call.
    or public.has_role(auth.uid(),'financial_ops')
  )
  with check (
    public.has_role(auth.uid(),'super_admin') or public.has_role(auth.uid(),'cfo')
    or public.has_role(auth.uid(),'coo') or public.has_role(auth.uid(),'ceo')
    -- app_role has no 'finance' member; the finance role in this codebase is
    -- 'financial_ops' (see the financial_ops enum value / financial-ops-daily
    -- naming elsewhere). The bare literal would fail every call.
    or public.has_role(auth.uid(),'financial_ops')
  );

-- ---------------------------------------------------------------------------
-- Part 3: rent-limit change history.
--
-- credit_access_limits.total_limit is the canonical rent-access figure
-- (57,205 rows, 2,228 updated in the trailing 30 days as of 2026-09-09) but
-- the table keeps no history, so "the limit actually increased" was not an
-- answerable question. Without this, RENT_LIMIT_INCREASED could only be
-- inferred from a payment -- which is exactly the false claim the catalogue
-- warns against.
--
-- The trigger fires only on a real change in total_limit, so the repeated
-- no-op writes from recalculate_credit_limit cost one comparison and log
-- nothing.
-- ---------------------------------------------------------------------------
create table if not exists public.credit_limit_change_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  old_total_limit numeric,
  new_total_limit numeric not null,
  delta numeric generated always as (coalesce(new_total_limit,0) - coalesce(old_total_limit,0)) stored,
  changed_at timestamptz not null default now(),
  notified_at timestamptz
);

create index if not exists idx_credit_limit_change_log_user_changed
  on public.credit_limit_change_log (user_id, changed_at desc);

-- Partial index: the sender only ever scans unnotified increases.
create index if not exists idx_credit_limit_change_log_pending
  on public.credit_limit_change_log (changed_at)
  where notified_at is null;

alter table public.credit_limit_change_log enable row level security;

create policy "credit_limit_change_log_ops_read"
  on public.credit_limit_change_log for select
  using (
    public.has_role(auth.uid(),'super_admin') or public.has_role(auth.uid(),'tenant_ops')
    or public.has_role(auth.uid(),'manager') or public.has_role(auth.uid(),'coo')
    or public.has_role(auth.uid(),'ceo') or public.has_role(auth.uid(),'cfo')
  );

create or replace function public.log_credit_limit_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.credit_limit_change_log (user_id, old_total_limit, new_total_limit)
  values (NEW.user_id, OLD.total_limit, NEW.total_limit);
  return NEW;
end;
$$;

drop trigger if exists trg_log_credit_limit_change on public.credit_access_limits;

create trigger trg_log_credit_limit_change
  after update on public.credit_access_limits
  for each row
  when (OLD.total_limit is distinct from NEW.total_limit)
  execute function public.log_credit_limit_change();

-- ---------------------------------------------------------------------------
-- Part 4: Stage 3 candidate selectors.
--
-- Each returns only tenants: an active Rent Plan, a phone number, not deleted.
-- Opt-out and blocked-number suppression is NOT repeated here -- every send
-- path already gates on sms_opt_outs and sms_message_exceptions inside
-- sendSmsMultiProvider, and a second copy would drift.
-- ---------------------------------------------------------------------------

-- 3A: relocation proposition. Any active tenant is eligible; the twice-weekly
-- ceiling is the marketing cap in the governor, not a rule repeated here.
create or replace function public.get_tenant_relocation_candidates(
  p_limit int default 2000,
  p_offset int default 0
)
returns table (
  tenant_id uuid,
  tenant_name text,
  tenant_phone text,
  outstanding numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id as tenant_id,
         p.full_name as tenant_name,
         p.phone as tenant_phone,
         greatest(0, coalesce(o.outstanding, 0))::numeric as outstanding
  from public.profiles p
  join (
    select e.tenant_id,
           max(coalesce(e.total_repayment,0) - coalesce(e.amount_repaid,0)) as outstanding
    from public.v_tenant_daily_eligibility e
    where e.status in ('funded','disbursed','repaying')
    group by e.tenant_id
  ) o on o.tenant_id = p.id
  where p.deleted_at is null
    and coalesce(p.phone, '') <> ''
  order by p.id
  limit greatest(1, least(coalesce(p_limit, 2000), 5000))
  offset greatest(0, coalesce(p_offset, 0));
$$;

revoke all on function public.get_tenant_relocation_candidates(int, int) from public;
grant execute on function public.get_tenant_relocation_candidates(int, int)
  to authenticated, service_role, postgres;

-- 3B: rent-limit increases. Reads the change log, so a message can only be
-- sent for an increase the limit engine actually performed.
create or replace function public.get_tenant_rent_limit_increase_candidates(
  p_max_age_hours int default 48,
  p_min_delta numeric default 1000
)
returns table (
  change_id uuid,
  tenant_id uuid,
  tenant_name text,
  tenant_phone text,
  old_total_limit numeric,
  new_total_limit numeric,
  delta numeric,
  changed_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select cl.id as change_id,
         p.id as tenant_id,
         p.full_name as tenant_name,
         p.phone as tenant_phone,
         cl.old_total_limit,
         cl.new_total_limit,
         cl.delta,
         cl.changed_at
  from public.credit_limit_change_log cl
  join public.profiles p on p.id = cl.user_id
  join public.user_roles ur
    on ur.user_id = p.id and ur.role = 'tenant' and ur.enabled
  where cl.notified_at is null
    and cl.delta >= greatest(coalesce(p_min_delta, 0), 0)
    and cl.changed_at >= now() - make_interval(hours => greatest(coalesce(p_max_age_hours, 48), 1))
    and p.deleted_at is null
    and coalesce(p.phone, '') <> '';
$$;

revoke all on function public.get_tenant_rent_limit_increase_candidates(int, numeric) from public;
grant execute on function public.get_tenant_rent_limit_increase_candidates(int, numeric)
  to authenticated, service_role, postgres;

-- Marks a change row notified so the same increase is never announced twice,
-- even if the notification log is later pruned.
create or replace function public.mark_credit_limit_change_notified(p_change_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  update public.credit_limit_change_log
  set notified_at = now()
  where id = p_change_id and notified_at is null;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function public.mark_credit_limit_change_notified(uuid) from public;
grant execute on function public.mark_credit_limit_change_notified(uuid)
  to service_role, postgres;

-- 3C: merchant-code reminder. Tenants carrying an unpaid obligation for the
-- day, so the message arrives when paying directly is actually useful.
create or replace function public.get_tenant_merchant_code_candidates(
  p_as_of date default ((now() at time zone 'Africa/Kampala')::date),
  p_max_days_since_last_payment int default 30,
  p_require_prior_payment boolean default true
)
returns table (
  tenant_id uuid,
  tenant_name text,
  tenant_phone text,
  daily_expected numeric,
  remaining_today numeric,
  outstanding numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with last_pay as (
    select ac.tenant_id,
           max((ac.created_at at time zone 'Africa/Kampala')::date) as last_pay_date
    from public.agent_collections ac
    where ac.amount > 0
    group by ac.tenant_id
  )
  select s.tenant_id,
         p.full_name as tenant_name,
         p.phone as tenant_phone,
         s.daily_expected,
         s.remaining_today,
         s.outstanding
  from public.get_tenant_payment_day_state(p_as_of, null) s
  join public.profiles p on p.id = s.tenant_id
  left join last_pay lp on lp.tenant_id = s.tenant_id
  where s.day_state in ('unpaid','partial')
    and s.daily_expected > 0
    and p.deleted_at is null
    and coalesce(p.phone, '') <> ''
    and (not p_require_prior_payment or lp.last_pay_date is not null)
    and (
      p_max_days_since_last_payment is null
      or lp.last_pay_date is null
      or (p_as_of - lp.last_pay_date) <= p_max_days_since_last_payment
    );
$$;

revoke all on function public.get_tenant_merchant_code_candidates(date, int, boolean) from public;
grant execute on function public.get_tenant_merchant_code_candidates(date, int, boolean)
  to authenticated, service_role, postgres;
