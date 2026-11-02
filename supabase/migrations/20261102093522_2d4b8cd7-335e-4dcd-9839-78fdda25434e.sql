create table public.welile_homes_collection_requests (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  subscription_id uuid not null references public.welile_homes_subscriptions(id) on delete restrict,
  caller_id uuid,
  source text not null,
  requested_amount numeric not null,
  response jsonb not null,
  created_at timestamptz not null default now()
);
grant select on public.welile_homes_collection_requests to authenticated;
grant all on public.welile_homes_collection_requests to service_role;
alter table public.welile_homes_collection_requests enable row level security;
create policy wh_collection_requests_read on public.welile_homes_collection_requests for select to authenticated
  using (caller_id = (select auth.uid()));
create policy mfa_required_for_staff on public.welile_homes_collection_requests as restrictive for all to authenticated
  using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));

drop function if exists public.welile_home_record_collection(uuid, numeric, text, text);

create function public.welile_home_record_collection(p_subscription_id uuid, p_amount numeric, p_source text, p_idempotency_key text, p_notes text default null)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_sub public.welile_homes_subscriptions%rowtype;
  v_prev public.welile_homes_collection_requests%rowtype;
  v_verified boolean;
  v_outstanding numeric; v_cap numeric; v_agent_comm numeric; v_remaining numeric; v_take numeric; v_room numeric;
  v_due record; v_legs jsonb; v_txn uuid; v_resp jsonb;
  v_strict_float numeric := 0; v_tenant_avail numeric := 0;
  v_key text := nullif(trim(p_idempotency_key), '');
begin
  if v_key is null or length(v_key) < 8 or length(v_key) > 200 then
    raise exception 'A collection request key (8 to 200 characters) is required' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  end if;
  if p_source not in ('tenant_wallet','agent_allocation') then
    return jsonb_build_object('success', false, 'error', 'Invalid source');
  end if;

  -- Same key: wait for any in-flight attempt, then return its original confirmation.
  perform pg_advisory_xact_lock(hashtext('wh_collect:' || v_key));
  select * into v_prev from public.welile_homes_collection_requests where idempotency_key = v_key;
  if found then
    if v_prev.subscription_id <> p_subscription_id or v_prev.requested_amount <> p_amount or v_prev.source <> p_source
       or (not v_service and v_prev.caller_id is distinct from v_uid) then
      raise exception 'This request key was already used for a different collection' using errcode = '22023';
    end if;
    return v_prev.response || jsonb_build_object('replayed', true);
  end if;

  -- Lock the plan, then its unpaid months, before reading any balance.
  select * into v_sub from public.welile_homes_subscriptions
   where id = p_subscription_id and mode = 'agent_collection' for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'Welile Homes subscription not found');
  end if;
  perform 1 from public.welile_homes_monthly_dues
   where subscription_id = p_subscription_id and collection_status <> 'collected'
   order by due_month_index for update;

  if not v_service then
    if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
    if p_source = 'agent_allocation' then
      if v_sub.agent_id is distinct from v_uid then
        raise exception 'only the managing agent can allocate rent for this subscription' using errcode = '42501';
      end if;
    elsif v_sub.tenant_id is distinct from v_uid then
      raise exception 'only the tenant can pay rent from their own wallet' using errcode = '42501';
    end if;
  end if;

  select coalesce(verified, false) into v_verified from public.profiles where id = v_sub.tenant_id;
  if not coalesce(v_verified, false) then
    raise exception 'COLLECTION_BLOCKED: the tenant is not verified by SMS code' using errcode = '42501';
  end if;
  if v_sub.funding_status is distinct from 'funded' then
    raise exception 'COLLECTION_BLOCKED: float for this plan is not funded yet' using errcode = '42501';
  end if;

  select greatest(0, coalesce(sum(amount_due - amount_collected), 0)) into v_outstanding
    from public.welile_homes_monthly_dues where subscription_id = p_subscription_id;
  v_outstanding := least(v_outstanding, coalesce(v_sub.outstanding_balance, 0));
  if v_outstanding <= 0 then
    return jsonb_build_object('success', false, 'error', 'No outstanding balance to collect');
  end if;
  v_cap := least(p_amount, v_outstanding);

  if p_source = 'tenant_wallet' then
    select greatest(0, coalesce(total_visible, 0)) into v_tenant_avail from public.wallet_strict_for_user(v_sub.tenant_id);
    if v_tenant_avail < v_cap then
      return jsonb_build_object('success', false, 'error_code', 'INSUFFICIENT_TENANT_BALANCE',
        'error', format('Tenant wallet balance (%s) is less than the amount to collect (%s)', v_tenant_avail, v_cap));
    end if;
  else
    if v_sub.agent_id is null then
      return jsonb_build_object('success', false, 'error', 'No managing agent for allocation');
    end if;
    select greatest(0, coalesce(float_balance, 0)) into v_strict_float from public.wallet_strict_for_user(v_sub.agent_id);
    if v_strict_float < v_cap then
      return jsonb_build_object('success', false, 'error_code', 'INSUFFICIENT_FLOAT',
        'error', format('Agent float (%s) is less than the amount to allocate (%s)', v_strict_float, v_cap));
    end if;
  end if;

  v_agent_comm := round(v_cap * 0.02, 2);

  if p_source = 'tenant_wallet' then
    v_legs := jsonb_build_array(
      jsonb_build_object('user_id',v_sub.tenant_id,'amount',v_cap,'direction','cash_out','category','rent_repayment','ledger_scope','wallet','classification','production','description','Welile Homes rent collected from tenant wallet','linked_party',v_sub.landlord_id,'source_table','welile_homes_monthly_dues','source_id',p_subscription_id),
      jsonb_build_object('user_id',v_sub.tenant_id,'amount',v_cap,'direction','cash_in','category','landlord_receivable_collected','ledger_scope','platform','classification','production','description','Welile Homes rent received','linked_party',v_sub.landlord_id,'source_table','welile_homes_subscriptions','source_id',p_subscription_id));
  else
    v_legs := jsonb_build_array(
      jsonb_build_object('user_id',v_sub.agent_id,'amount',v_cap,'direction','cash_out','category','rent_payment_for_tenant','ledger_scope','wallet','classification','production','description','Welile Homes rent allocated from agent float','linked_party',v_sub.landlord_id,'recipient_type','operational_wallet','source_table','welile_homes_monthly_dues','source_id',p_subscription_id),
      jsonb_build_object('user_id',v_sub.agent_id,'amount',v_cap,'direction','cash_in','category','landlord_receivable_collected','ledger_scope','platform','classification','production','description','Welile Homes rent received (agent-allocated)','linked_party',v_sub.landlord_id,'source_table','welile_homes_subscriptions','source_id',p_subscription_id));
  end if;
  if v_sub.agent_id is not null and v_agent_comm > 0 then
    v_legs := v_legs || jsonb_build_array(
      jsonb_build_object('user_id',v_sub.agent_id,'amount',v_agent_comm,'direction','cash_out','category','agent_commission_payable','ledger_scope','platform','classification','production','description','Welile Homes 2% agent commission (platform)','source_table','welile_homes_subscriptions','source_id',p_subscription_id),
      jsonb_build_object('user_id',v_sub.agent_id,'amount',v_agent_comm,'direction','cash_in','category','agent_commission_earned','ledger_scope','wallet','classification','production','description','Welile Homes 2% agent commission','recipient_type','user','source_table','welile_homes_subscriptions','source_id',p_subscription_id));
  end if;

  v_txn := public.create_ledger_transaction(v_legs, 'welile_home_collect:' || v_key, true);

  v_remaining := v_cap;
  for v_due in
    select id, amount_due, amount_collected from public.welile_homes_monthly_dues
     where subscription_id = p_subscription_id and collection_status <> 'collected'
     order by due_month_index
  loop
    exit when v_remaining <= 0;
    v_room := v_due.amount_due - v_due.amount_collected;
    if v_room <= 0 then continue; end if;
    v_take := least(v_remaining, v_room);
    update public.welile_homes_monthly_dues
       set amount_collected = amount_collected + v_take,
           collection_status = case when amount_collected + v_take >= amount_due then 'collected' else 'partial' end,
           ledger_transaction_id = coalesce(ledger_transaction_id, v_txn),
           updated_at = now()
     where id = v_due.id;
    v_remaining := v_remaining - v_take;
  end loop;

  update public.welile_homes_subscriptions
     set outstanding_balance = greatest(0, outstanding_balance - v_cap),
         next_due_date = (select min(payout_date) from public.welile_homes_monthly_dues
                           where subscription_id = p_subscription_id and collection_status <> 'collected'),
         updated_at = now()
   where id = p_subscription_id;

  begin
    insert into public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
    values ('payment_made', v_sub.tenant_id, 'welile_homes_subscription', p_subscription_id,
      jsonb_build_object('action','collection','source',p_source,'amount',v_cap,'agent_commission',v_agent_comm,'txn',v_txn,'idempotency_key',v_key));
  exception when others then null; end;

  v_resp := jsonb_build_object('success', true, 'transaction_group', v_txn, 'amount_collected', v_cap,
                               'agent_commission', v_agent_comm, 'source', p_source);
  insert into public.welile_homes_collection_requests (idempotency_key, subscription_id, caller_id, source, requested_amount, response)
  values (v_key, p_subscription_id, v_uid, p_source, p_amount, v_resp);
  return v_resp;
end;
$function$;

revoke all on function public.welile_home_record_collection(uuid, numeric, text, text, text) from public, anon;
grant execute on function public.welile_home_record_collection(uuid, numeric, text, text, text) to authenticated, service_role;

create or replace function public.trg_welile_home_auto_collect()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_sub uuid; v_out numeric; v_avail numeric; v_amt numeric;
begin
  if new.event_type not in ('deposit_approved','funds_added') then return new; end if;
  if new.user_id is null then return new; end if;
  select id, outstanding_balance into v_sub, v_out from public.welile_homes_subscriptions
   where tenant_id = new.user_id and mode = 'agent_collection' and subscription_status = 'active'
     and outstanding_balance > 0 and funding_status = 'funded'
   order by next_due_date nulls last limit 1;
  if v_sub is null then return new; end if;
  select greatest(0, coalesce(total_visible, 0)) into v_avail from public.wallet_strict_for_user(new.user_id);
  v_amt := least(coalesce(v_out, 0), coalesce(v_avail, 0));
  if v_amt > 0 then
    perform public.welile_home_record_collection(v_sub, v_amt, 'tenant_wallet', 'auto_deposit:' || new.id::text, 'Auto-collected on deposit');
  end if;
  return new;
exception when others then
  return new;
end;
$function$;