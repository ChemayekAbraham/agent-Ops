-- Welile Homes float: real link, server-only stages, atomic CFO disbursement.
-- PROPOSAL — not applied. Apply through the approved migration workflow only after
-- the live-schema check (float_requests, welile_homes_subscriptions columns and
-- whether an edge function `send-operational-float` is deployed) comes back.
-- Ship together with the Phase 2 browser changes: after this runs, the old
-- browser writes to Welile Homes float requests are refused by design.
--
-- Why:
--   * float_requests was shared by Merchant Float and Welile Homes with no marker, so a
--     Welile Homes request could be funded from the Merchant panel, skipping Agent Ops,
--     Tenant Ops and COO.
--   * Requests carried no subscription ids; the link was guessed from the reason text.
--   * Every stage change, and the CFO "disbursement", was a browser table write. The CFO
--     Welile Homes desk called a function that does not exist and marked the request
--     approved anyway, so "approved" never proved money moved.
-- What:
--   1. float_requests.product ('merchant' | 'welile_homes') + disbursed_ledger_txn.
--   2. welile_homes_float_request_items: which subscriptions a request covers.
--   3. welile_homes_subscriptions.funding_status: unfunded -> requested -> funded.
--   4. wh_request_float / wh_float_advance / wh_cfo_disburse_float: the only writers.
--   5. A guard trigger refusing any other write to Welile Homes float requests.
-- Ledger: the CFO posting mirrors the Merchant panel's existing agent float credit
-- (wallet cash_in agent_float_deposit, float bucket, operational_wallet; platform
-- cash_out agent_float_deposit) — no new category, mapping or money flow. CFO approved
-- reuse on 2026-10-26.
-- Rollback: docs/pending-migrations/welile_homes_float_link.rollback.sql

begin;

-- 1. Product marker and proof of disbursement ---------------------------------------
alter table public.float_requests
  add column if not exists product text not null default 'merchant',
  add column if not exists disbursed_ledger_txn uuid;

do $$ begin
  alter table public.float_requests
    add constraint float_requests_product_chk check (product in ('merchant','welile_homes'));
exception when duplicate_object then null; end $$;

-- Backfill from the reason text the Welile Homes agent form always writes.
-- Review list before applying:
--   select id, agent_id, status, requested_amount, reason from public.float_requests
--   where reason ilike '%welile homes%' order by created_at;
update public.float_requests
   set product = 'welile_homes'
 where product = 'merchant'
   and reason ilike '%welile homes%';

create index if not exists float_requests_product_status_idx
  on public.float_requests (product, status, created_at desc);

-- 2. The link ----------------------------------------------------------------------
create table if not exists public.welile_homes_float_request_items (
  id               uuid primary key default gen_random_uuid(),
  float_request_id uuid not null references public.float_requests(id) on delete restrict,
  subscription_id  uuid not null references public.welile_homes_subscriptions(id) on delete restrict,
  amount           numeric not null check (amount > 0),
  created_at       timestamptz not null default now(),
  released_at      timestamptz,            -- set when the request is rejected
  unique (float_request_id, subscription_id)
);
-- A subscription can sit in only one open request at a time.
create unique index if not exists wh_float_items_one_open_per_sub
  on public.welile_homes_float_request_items (subscription_id)
  where released_at is null;
create index if not exists wh_float_items_request_idx
  on public.welile_homes_float_request_items (float_request_id);

alter table public.welile_homes_float_request_items enable row level security;
revoke all on public.welile_homes_float_request_items from anon, authenticated;
grant select on public.welile_homes_float_request_items to authenticated;

drop policy if exists wh_float_items_read on public.welile_homes_float_request_items;
create policy wh_float_items_read on public.welile_homes_float_request_items
  for select to authenticated
  using (
    exists (select 1 from public.float_requests fr
             where fr.id = float_request_id and fr.agent_id = auth.uid())
    or public.has_role(auth.uid(), 'agent_ops') or public.has_role(auth.uid(), 'tenant_ops')
    or public.has_role(auth.uid(), 'coo') or public.has_role(auth.uid(), 'cfo')
    or public.has_role(auth.uid(), 'ceo') or public.has_role(auth.uid(), 'super_admin')
  );

-- 3. Funding status, separate from enrollment status ---------------------------------
alter table public.welile_homes_subscriptions
  add column if not exists funding_status text not null default 'unfunded';
do $$ begin
  alter table public.welile_homes_subscriptions
    add constraint wh_subs_funding_status_chk check (funding_status in ('unfunded','requested','funded'));
exception when duplicate_object then null; end $$;
-- Existing rows stay 'unfunded': requests approved under the old logic have no
-- subscription link and moved no verifiable money. They are listed as "Old Logic".

-- 4a. Guard: only the functions below may write Welile Homes float requests ---------
create or replace function public._wh_float_guard()
returns trigger language plpgsql set search_path to 'public'
as $f$
begin
  if coalesce(current_setting('welile.wh_float_rpc', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.product = 'welile_homes' or coalesce(new.reason, '') ilike '%welile homes%' then
      raise exception 'Welile Homes float requests are created only through wh_request_float'
        using errcode = '42501';
    end if;
    return new;
  end if;
  -- UPDATE
  if old.product = 'welile_homes' or new.product is distinct from old.product then
    raise exception 'Welile Homes float requests change only through wh_float_advance / wh_cfo_disburse_float'
      using errcode = '42501';
  end if;
  if new.disbursed_ledger_txn is distinct from old.disbursed_ledger_txn then
    raise exception 'disbursed_ledger_txn is set only by wh_cfo_disburse_float' using errcode = '42501';
  end if;
  return new;
end $f$;

drop trigger if exists trg_wh_float_guard on public.float_requests;
create trigger trg_wh_float_guard
  before insert or update on public.float_requests
  for each row execute function public._wh_float_guard();

-- Same guard for funding_status on subscriptions.
create or replace function public._wh_funding_status_guard()
returns trigger language plpgsql set search_path to 'public'
as $f$
begin
  if new.funding_status is distinct from old.funding_status
     and coalesce(current_setting('welile.wh_float_rpc', true), '') <> 'on' then
    raise exception 'funding_status changes only through the Welile Homes float functions'
      using errcode = '42501';
  end if;
  return new;
end $f$;

drop trigger if exists trg_wh_funding_status_guard on public.welile_homes_subscriptions;
create trigger trg_wh_funding_status_guard
  before update of funding_status on public.welile_homes_subscriptions
  for each row execute function public._wh_funding_status_guard();

-- 4b. Agent requests float for specific subscriptions --------------------------------
create or replace function public.wh_request_float(
  p_subscription_ids uuid[],
  p_recipient_phone  text default null,
  p_notes            text default null
) returns jsonb
language plpgsql security definer set search_path to 'public'
as $f$
declare
  v_uid uuid := auth.uid();
  v_ids uuid[];
  v_found int;
  v_total numeric;
  v_req uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  select array_agg(distinct x) into v_ids from unnest(p_subscription_ids) x where x is not null;
  if v_ids is null or cardinality(v_ids) = 0 then
    raise exception 'Select at least one tenant' using errcode = '22023';
  end if;
  if cardinality(v_ids) > 200 then
    raise exception 'At most 200 tenants per request' using errcode = '22023';
  end if;

  -- Lock the rows; every one must be the caller's, active, unfunded and not already requested.
  perform 1 from public.welile_homes_subscriptions s where s.id = any(v_ids) for update;

  select count(*), coalesce(sum(s.monthly_rent), 0) into v_found, v_total
    from public.welile_homes_subscriptions s
   where s.id = any(v_ids)
     and s.agent_id = v_uid
     and s.subscription_status = 'active'
     and s.mode = 'agent_collection'
     and s.funding_status = 'unfunded'
     and s.monthly_rent > 0;

  if v_found <> cardinality(v_ids) then
    raise exception 'Some tenants are not yours, not active, or already have a float request'
      using errcode = '42501';
  end if;

  perform set_config('welile.wh_float_rpc', 'on', true);

  insert into public.float_requests (agent_id, requested_amount, reason, expected_recipient_phone, status, product)
  values (
    v_uid, v_total,
    format('Welile Homes landlord float (%s tenants)', cardinality(v_ids))
      || coalesce(': ' || nullif(trim(p_notes), ''), ''),
    nullif(trim(p_recipient_phone), ''),
    'pending', 'welile_homes'
  ) returning id into v_req;

  insert into public.welile_homes_float_request_items (float_request_id, subscription_id, amount)
  select v_req, s.id, s.monthly_rent
    from public.welile_homes_subscriptions s where s.id = any(v_ids);

  update public.welile_homes_subscriptions
     set funding_status = 'requested', updated_at = now()
   where id = any(v_ids);

  return jsonb_build_object('success', true, 'request_id', v_req,
                            'amount', v_total, 'tenant_count', cardinality(v_ids));
end $f$;

-- 4c. Agent Ops / Tenant Ops / COO / CFO-reject transitions --------------------------
-- p_action: 'approve' | 'reject' | 'return'. p_expected_status must match the current
-- status, so two reviewers can never act on the same request twice.
create or replace function public.wh_float_advance(
  p_request_id      uuid,
  p_expected_status text,
  p_action          text,
  p_note            text default null
) returns jsonb
language plpgsql security definer set search_path to 'public'
as $f$
declare
  v_uid uuid := auth.uid();
  v_req public.float_requests%rowtype;
  v_next text;
  v_allowed boolean := false;
  v_admin boolean;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if p_action not in ('approve','reject','return') then
    raise exception 'Unknown action %', p_action using errcode = '22023';
  end if;

  select * into v_req from public.float_requests where id = p_request_id for update;
  if not found or v_req.product <> 'welile_homes' then
    raise exception 'Welile Homes float request not found' using errcode = '22023';
  end if;
  if v_req.status is distinct from p_expected_status then
    raise exception 'Request is now "%", not "%" — refresh and try again', v_req.status, p_expected_status
      using errcode = '40001';
  end if;

  v_admin := public.has_role(v_uid, 'super_admin');

  case v_req.status
    when 'pending' then
      v_allowed := v_admin or public.has_role(v_uid, 'agent_ops');
      v_next := case p_action when 'approve' then 'agent_ops_approved' when 'reject' then 'rejected' end;
    when 'agent_ops_approved' then
      v_allowed := v_admin or public.has_role(v_uid, 'tenant_ops');
      v_next := case p_action when 'approve' then 'tenant_ops_approved' when 'reject' then 'rejected'
                              when 'return' then 'pending' end;
    when 'tenant_ops_approved' then
      v_allowed := v_admin or public.has_role(v_uid, 'coo');
      v_next := case p_action when 'approve' then 'coo_approved' when 'reject' then 'rejected'
                              when 'return' then 'agent_ops_approved' end;
    when 'coo_approved' then
      -- Approval at this stage is disbursement: wh_cfo_disburse_float only.
      v_allowed := v_admin or public.has_role(v_uid, 'cfo');
      v_next := case p_action when 'reject' then 'rejected' when 'return' then 'tenant_ops_approved' end;
    else
      raise exception 'Request in status "%" cannot change', v_req.status using errcode = '22023';
  end case;

  if not v_allowed then
    raise exception 'Your role cannot act on a request at this stage' using errcode = '42501';
  end if;
  if v_next is null then
    raise exception 'Action "%" is not available at stage "%"', p_action, v_req.status using errcode = '22023';
  end if;
  if p_action in ('reject','return') and length(trim(coalesce(p_note, ''))) < 5 then
    raise exception 'Add a reason of at least 5 characters' using errcode = '22023';
  end if;
  if p_action = 'approve' and not exists (
       select 1 from public.welile_homes_float_request_items i
        where i.float_request_id = p_request_id and i.released_at is null) then
    raise exception 'This request has no linked tenants (created before the new flow). Reject it with a note; the agent must request again.'
      using errcode = '22023';
  end if;

  perform set_config('welile.wh_float_rpc', 'on', true);

  update public.float_requests
     set status = v_next,
         rejection_reason = case when p_action in ('reject','return') then trim(p_note) else rejection_reason end,
         updated_at = now()
   where id = p_request_id;

  if v_next = 'rejected' then
    update public.welile_homes_subscriptions s
       set funding_status = 'unfunded', updated_at = now()
      from public.welile_homes_float_request_items i
     where i.float_request_id = p_request_id and i.released_at is null and s.id = i.subscription_id;
    update public.welile_homes_float_request_items
       set released_at = now()
     where float_request_id = p_request_id and released_at is null;
  end if;

  return jsonb_build_object('success', true, 'request_id', p_request_id, 'status', v_next);
end $f$;

-- 4d. CFO disbursement: credit, status and funding in one transaction ----------------
create or replace function public.wh_cfo_disburse_float(p_request_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $f$
declare
  v_uid uuid := auth.uid();
  v_req public.float_requests%rowtype;
  v_items int;
  v_items_total numeric;
  v_txn uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if not (public.has_role(v_uid, 'cfo') or public.has_role(v_uid, 'super_admin')) then
    raise exception 'Only the CFO can disburse Welile Homes float' using errcode = '42501';
  end if;

  select * into v_req from public.float_requests where id = p_request_id for update;
  if not found or v_req.product <> 'welile_homes' then
    raise exception 'Welile Homes float request not found' using errcode = '22023';
  end if;
  if v_req.status <> 'coo_approved' then
    raise exception 'Request is "%"; only COO-approved requests can be disbursed', v_req.status
      using errcode = '40001';
  end if;

  select count(*), coalesce(sum(amount), 0) into v_items, v_items_total
    from public.welile_homes_float_request_items
   where float_request_id = p_request_id and released_at is null;
  if v_items = 0 then
    raise exception 'Request has no linked tenants (created under the old logic) — cannot disburse'
      using errcode = '22023';
  end if;
  if v_items_total <> v_req.requested_amount then
    raise exception 'Linked tenant total % does not match requested amount %', v_items_total, v_req.requested_amount
      using errcode = '22023';
  end if;

  -- Same two legs as the Merchant panel's agent float credit (cfo-direct-credit,
  -- wallet_category = platform_category = agent_float_deposit, operational_wallet).
  -- Idempotency key makes a retry a no-op instead of a second credit.
  -- skip_balance_check = false: create_ledger_transaction always enforces debits = credits; the
  -- flag only skips the sufficient-balance check on wallet cash_out legs from the withdrawable
  -- bucket. This posting has none (wallet cash_in to float + platform cash_out), so the check
  -- has nothing to block today, and stays active if the shape ever changes.
  v_txn := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_req.agent_id, 'amount', v_req.requested_amount,
        'direction', 'cash_in', 'category', 'agent_float_deposit',
        'ledger_scope', 'wallet', 'wallet_bucket', 'float', 'recipient_type', 'operational_wallet',
        'source_table', 'float_requests', 'source_id', v_req.id,
        'description', format('Welile Homes landlord float — %s tenants, request %s', v_items, v_req.id),
        'currency', 'UGX', 'transaction_date', now()),
      jsonb_build_object(
        'user_id', v_uid, 'amount', v_req.requested_amount,
        'direction', 'cash_out', 'category', 'agent_float_deposit',
        'ledger_scope', 'platform',
        'source_table', 'float_requests', 'source_id', v_req.id,
        'description', format('Welile Homes landlord float to agent %s, request %s', v_req.agent_id, v_req.id),
        'currency', 'UGX', 'transaction_date', now())
    ),
    'wh_float:' || v_req.id::text,
    false  -- keep the built-in balance checks on (see note above)
  );
  if v_txn is null then
    raise exception 'Ledger posting returned no transaction' using errcode = 'P0001';
  end if;

  perform set_config('welile.wh_float_rpc', 'on', true);

  update public.float_requests
     set status = 'approved',
         approved_by = v_uid,
         approved_at = now(),
         approved_amount = v_req.requested_amount,
         disbursed_ledger_txn = v_txn,
         updated_at = now()
   where id = p_request_id;

  update public.welile_homes_subscriptions s
     set funding_status = 'funded', updated_at = now()
    from public.welile_homes_float_request_items i
   where i.float_request_id = p_request_id and i.released_at is null and s.id = i.subscription_id;

  return jsonb_build_object('success', true, 'request_id', p_request_id,
                            'amount', v_req.requested_amount, 'tenant_count', v_items,
                            'ledger_transaction_id', v_txn);
end $f$;

revoke all on function public.wh_request_float(uuid[], text, text) from public, anon;
revoke all on function public.wh_float_advance(uuid, text, text, text) from public, anon;
revoke all on function public.wh_cfo_disburse_float(uuid) from public, anon;
revoke all on function public._wh_float_guard() from public, anon, authenticated;
revoke all on function public._wh_funding_status_guard() from public, anon, authenticated;
grant execute on function public.wh_request_float(uuid[], text, text) to authenticated;
grant execute on function public.wh_float_advance(uuid, text, text, text) to authenticated;
grant execute on function public.wh_cfo_disburse_float(uuid) to authenticated;

commit;

-- Verify after applying (read-only):
--   select product, status, count(*) from public.float_requests group by 1,2 order by 1,2;
--   select funding_status, count(*) from public.welile_homes_subscriptions group by 1;
--   -- After a test disbursement: the group balances and shows both legs
--   select ledger_scope, direction, category, wallet_bucket, amount
--     from public.general_ledger where transaction_group_id = '<ledger_transaction_id>';
--   select public.assert_money_path_intact();
