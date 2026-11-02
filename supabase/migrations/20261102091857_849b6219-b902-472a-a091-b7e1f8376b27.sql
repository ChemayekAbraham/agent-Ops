alter table public.float_requests
  add column if not exists product text not null default 'merchant',
  add column if not exists disbursed_ledger_txn uuid;

do $$ begin
  alter table public.float_requests
    add constraint float_requests_product_chk check (product in ('merchant','welile_homes'));
exception when duplicate_object then null; end $$;

update public.float_requests set product = 'welile_homes'
 where product = 'merchant' and reason ilike '%welile homes%';

create index if not exists float_requests_product_status_idx
  on public.float_requests (product, status, created_at desc);

create table if not exists public.welile_homes_float_request_items (
  id               uuid primary key default gen_random_uuid(),
  float_request_id uuid not null references public.float_requests(id) on delete restrict,
  subscription_id  uuid not null references public.welile_homes_subscriptions(id) on delete restrict,
  amount           numeric not null check (amount > 0),
  created_at       timestamptz not null default now(),
  released_at      timestamptz,
  unique (float_request_id, subscription_id)
);
create unique index if not exists wh_float_items_one_open_per_sub
  on public.welile_homes_float_request_items (subscription_id) where released_at is null;
create index if not exists wh_float_items_request_idx
  on public.welile_homes_float_request_items (float_request_id);

revoke all on public.welile_homes_float_request_items from anon, authenticated;
grant select on public.welile_homes_float_request_items to authenticated;
grant all on public.welile_homes_float_request_items to service_role;
alter table public.welile_homes_float_request_items enable row level security;

drop policy if exists wh_float_items_read on public.welile_homes_float_request_items;
create policy wh_float_items_read on public.welile_homes_float_request_items
  for select to authenticated
  using (
    exists (select 1 from public.float_requests fr where fr.id = float_request_id and fr.agent_id = (select auth.uid()))
    or (select public.has_role((select auth.uid()), 'agent_ops')) or (select public.has_role((select auth.uid()), 'tenant_ops'))
    or (select public.has_role((select auth.uid()), 'coo')) or (select public.has_role((select auth.uid()), 'cfo'))
    or (select public.has_role((select auth.uid()), 'ceo')) or (select public.has_role((select auth.uid()), 'super_admin'))
  );
create policy mfa_required_for_staff on public.welile_homes_float_request_items as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));

alter table public.welile_homes_subscriptions
  add column if not exists funding_status text not null default 'unfunded';
do $$ begin
  alter table public.welile_homes_subscriptions
    add constraint wh_subs_funding_status_chk check (funding_status in ('unfunded','requested','funded'));
exception when duplicate_object then null; end $$;

create or replace function public._wh_float_guard()
returns trigger language plpgsql set search_path to 'public'
as $f$
begin
  if coalesce(current_setting('welile.wh_float_rpc', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.product = 'welile_homes' or coalesce(new.reason, '') ilike '%welile homes%' then
      raise exception 'Welile Homes float requests are created only through wh_request_float' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.product = 'welile_homes' or new.product is distinct from old.product then
    raise exception 'Welile Homes float requests change only through wh_float_advance / wh_cfo_disburse_float' using errcode = '42501';
  end if;
  if new.disbursed_ledger_txn is distinct from old.disbursed_ledger_txn then
    raise exception 'disbursed_ledger_txn is set only by wh_cfo_disburse_float' using errcode = '42501';
  end if;
  return new;
end $f$;

drop trigger if exists trg_wh_float_guard on public.float_requests;
create trigger trg_wh_float_guard before insert or update on public.float_requests
  for each row execute function public._wh_float_guard();

create or replace function public._wh_funding_status_guard()
returns trigger language plpgsql set search_path to 'public'
as $f$
begin
  if new.funding_status is distinct from old.funding_status
     and coalesce(current_setting('welile.wh_float_rpc', true), '') <> 'on' then
    raise exception 'funding_status changes only through the Welile Homes float functions' using errcode = '42501';
  end if;
  return new;
end $f$;

drop trigger if exists trg_wh_funding_status_guard on public.welile_homes_subscriptions;
create trigger trg_wh_funding_status_guard before update of funding_status on public.welile_homes_subscriptions
  for each row execute function public._wh_funding_status_guard();

create or replace function public.wh_request_float(
  p_subscription_ids uuid[], p_recipient_phone text default null, p_notes text default null
) returns jsonb
language plpgsql security definer set search_path to 'public'
as $f$
declare
  v_uid uuid := auth.uid();
  v_ids uuid[];
  v_found int;
  v_total numeric;
  v_bad int;
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

  perform 1 from public.welile_homes_subscriptions s where s.id = any(v_ids) for update;

  select count(*) into v_found from public.welile_homes_subscriptions s
   where s.id = any(v_ids) and s.agent_id = v_uid and s.subscription_status = 'active'
     and s.mode = 'agent_collection' and s.funding_status = 'unfunded';
  if v_found <> cardinality(v_ids) then
    raise exception 'Some tenants are not yours, not active, or already have a float request' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.welile_homes_subscriptions s
     where s.id = any(v_ids)
       and ((s.landlord_id is not null and not exists (
               select 1 from public.landlords l where l.id = s.landlord_id and l.registered_by = v_uid))
         or (s.landlord_id is null and nullif(trim(s.landlord_phone), '') is not null
             and exists (select 1 from public.landlords l where l.phone = trim(s.landlord_phone) and l.registered_by is distinct from v_uid)
             and not exists (select 1 from public.landlords l where l.phone = trim(s.landlord_phone) and l.registered_by = v_uid)))
  ) then
    raise exception 'Float can only be requested for landlords you registered' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.welile_homes_subscriptions s
      left join public.profiles p on p.id = s.tenant_id
     where s.id = any(v_ids) and coalesce(p.verified, false) is not true
  ) then
    raise exception 'Every tenant must be verified by SMS code before float can be requested' using errcode = '42501';
  end if;

  -- Amount comes only from dues rows: each tenant's earliest month still owing.
  select count(*) filter (where amt is null or amt <= 0), coalesce(sum(amt) filter (where amt > 0), 0)
    into v_bad, v_total
    from (select s.id, (select d.amount_due - coalesce(d.amount_collected, 0)
                          from public.welile_homes_monthly_dues d
                         where d.subscription_id = s.id and d.collection_status <> 'collected'
                         order by d.due_month_index limit 1) amt
            from public.welile_homes_subscriptions s where s.id = any(v_ids)) x;
  if v_bad > 0 or v_total <= 0 then
    raise exception 'Some tenants have no unpaid monthly due to fund' using errcode = '22023';
  end if;

  perform set_config('welile.wh_float_rpc', 'on', true);

  insert into public.float_requests (agent_id, requested_amount, reason, expected_recipient_phone, status, product)
  values (v_uid, v_total,
    format('Welile Homes landlord float (%s tenants)', cardinality(v_ids)) || coalesce(': ' || nullif(trim(p_notes), ''), ''),
    nullif(trim(p_recipient_phone), ''), 'pending', 'welile_homes')
  returning id into v_req;

  insert into public.welile_homes_float_request_items (float_request_id, subscription_id, amount)
  select v_req, s.id, (select d.amount_due - coalesce(d.amount_collected, 0)
                         from public.welile_homes_monthly_dues d
                        where d.subscription_id = s.id and d.collection_status <> 'collected'
                        order by d.due_month_index limit 1)
    from public.welile_homes_subscriptions s where s.id = any(v_ids);

  update public.welile_homes_subscriptions set funding_status = 'requested', updated_at = now() where id = any(v_ids);

  return jsonb_build_object('success', true, 'request_id', v_req, 'amount', v_total, 'tenant_count', cardinality(v_ids));
end $f$;

create or replace function public.wh_float_advance(
  p_request_id uuid, p_expected_status text, p_action text, p_note text default null
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
    raise exception 'Request is now "%", not "%" - refresh and try again', v_req.status, p_expected_status using errcode = '40001';
  end if;

  v_admin := public.has_role(v_uid, 'super_admin');

  case v_req.status
    when 'pending' then
      v_allowed := v_admin or public.has_role(v_uid, 'agent_ops');
      v_next := case p_action when 'approve' then 'agent_ops_approved' when 'reject' then 'rejected' end;
    when 'agent_ops_approved' then
      v_allowed := v_admin or public.has_role(v_uid, 'tenant_ops');
      v_next := case p_action when 'approve' then 'tenant_ops_approved' when 'reject' then 'rejected' when 'return' then 'pending' end;
    when 'tenant_ops_approved' then
      v_allowed := v_admin or public.has_role(v_uid, 'coo');
      v_next := case p_action when 'approve' then 'coo_approved' when 'reject' then 'rejected' when 'return' then 'agent_ops_approved' end;
    when 'coo_approved' then
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
       select 1 from public.welile_homes_float_request_items i where i.float_request_id = p_request_id and i.released_at is null) then
    raise exception 'This request has no linked tenants (created before the new flow). Reject it with a note; the agent must request again.' using errcode = '22023';
  end if;

  perform set_config('welile.wh_float_rpc', 'on', true);

  update public.float_requests
     set status = v_next,
         rejection_reason = case when p_action in ('reject','return') then trim(p_note) else rejection_reason end,
         updated_at = now()
   where id = p_request_id;

  if v_next = 'rejected' then
    update public.welile_homes_subscriptions s set funding_status = 'unfunded', updated_at = now()
      from public.welile_homes_float_request_items i
     where i.float_request_id = p_request_id and i.released_at is null and s.id = i.subscription_id;
    update public.welile_homes_float_request_items set released_at = now()
     where float_request_id = p_request_id and released_at is null;
  end if;

  return jsonb_build_object('success', true, 'request_id', p_request_id, 'status', v_next);
end $f$;

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
    raise exception 'Request is "%"; only COO-approved requests can be disbursed', v_req.status using errcode = '40001';
  end if;

  select count(*), coalesce(sum(amount), 0) into v_items, v_items_total
    from public.welile_homes_float_request_items where float_request_id = p_request_id and released_at is null;
  if v_items = 0 then
    raise exception 'Request has no linked tenants (created under the old logic) - cannot disburse' using errcode = '22023';
  end if;
  if v_items_total <> v_req.requested_amount then
    raise exception 'Linked tenant total % does not match requested amount %', v_items_total, v_req.requested_amount using errcode = '22023';
  end if;

  v_txn := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_req.agent_id, 'amount', v_items_total,
        'direction', 'cash_in', 'category', 'agent_float_deposit',
        'ledger_scope', 'wallet', 'wallet_bucket', 'float', 'recipient_type', 'operational_wallet',
        'source_table', 'float_requests', 'source_id', v_req.id,
        'description', format('Welile Homes landlord float - %s tenants, request %s', v_items, v_req.id),
        'currency', 'UGX', 'transaction_date', now()),
      jsonb_build_object(
        'user_id', v_uid, 'amount', v_items_total,
        'direction', 'cash_out', 'category', 'agent_float_deposit',
        'ledger_scope', 'platform',
        'source_table', 'float_requests', 'source_id', v_req.id,
        'description', format('Welile Homes landlord float to agent %s, request %s', v_req.agent_id, v_req.id),
        'currency', 'UGX', 'transaction_date', now())
    ),
    'wh_float:' || v_req.id::text,
    false
  );
  if v_txn is null then
    raise exception 'Ledger posting returned no transaction' using errcode = 'P0001';
  end if;

  perform set_config('welile.wh_float_rpc', 'on', true);

  update public.float_requests
     set status = 'approved', approved_by = v_uid, approved_at = now(),
         approved_amount = v_items_total, disbursed_ledger_txn = v_txn, updated_at = now()
   where id = p_request_id;

  update public.welile_homes_subscriptions s set funding_status = 'funded', updated_at = now()
    from public.welile_homes_float_request_items i
   where i.float_request_id = p_request_id and i.released_at is null and s.id = i.subscription_id;

  return jsonb_build_object('success', true, 'request_id', p_request_id, 'amount', v_items_total,
                            'tenant_count', v_items, 'ledger_transaction_id', v_txn);
end $f$;

revoke all on function public.wh_request_float(uuid[], text, text) from public, anon;
revoke all on function public.wh_float_advance(uuid, text, text, text) from public, anon;
revoke all on function public.wh_cfo_disburse_float(uuid) from public, anon;
revoke all on function public._wh_float_guard() from public, anon, authenticated;
revoke all on function public._wh_funding_status_guard() from public, anon, authenticated;
grant execute on function public.wh_request_float(uuid[], text, text) to authenticated, service_role;
grant execute on function public.wh_float_advance(uuid, text, text, text) to authenticated, service_role;
grant execute on function public.wh_cfo_disburse_float(uuid) to authenticated, service_role;