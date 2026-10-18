-- 2026-10-18 (doc 247, step 13): three functions the browser calls that trusted whoever called them.
--
-- welile_home_record_collection(subscription, amount, source, notes): with source 'tenant_wallet' it debited the TENANT's wallet and with
--   'agent_allocation' the AGENT's float, for ANY subscription, credited a 2% commission to the subscription's agent, and applied the amount to
--   the dues; the dues later pay out 90% to the landlord's wallet or the agent's landlord float. Any signed-in user could drain another tenant's
--   wallet into a subscription they controlled. Now: service role; for 'agent_allocation' only the subscription's own agent; for 'tenant_wallet'
--   only the tenant themselves. (The only browser caller, AgentWelileHomesSheet, uses 'agent_allocation' as the agent.)
--
-- enroll_welile_home_tenant(tenant, agent, rent, ...): trusted p_tenant_id and p_agent_id and UPSERTS on tenant_id, so anyone could overwrite
--   another agent's subscription (agent, rent, landlord details) and take over its commissions and payouts; it also accepted p_landlord_id, which
--   decides whose wallet the landlord payout goes to (the UI always passes null). Now: service role; staff (is_sensitive_field_editor or an active
--   staff permission for agent-ops / tenant-ops / company-ops) without restriction; an agent / senior agent / sub-agent only for themselves, only
--   for a tenant not already enrolled under a different agent, and with p_landlord_id ignored.
--
-- ensure_payout_destination(user, method, ...): registers or updates a payout-destination verification row for p_user_id (partners with no
--   agent activity are auto-verified; a verified row whose name no longer matches is pushed back to 'waiting'). It trusted p_user_id, so anyone
--   could register destinations for, or block the verified destination of, another user. Now: service role (the issue-wallet-withdrawal-otp edge
--   function uses the admin client), the user themselves, or financial-ops staff.
--
-- Already applied to production 2026-10-18.
create or replace function public.ensure_payout_destination(p_user_id uuid, p_method text, p_momo_number text default null::text, p_momo_name text default null::text, p_provider text default null::text, p_bank_name text default null::text, p_bank_account_number text default null::text, p_bank_account_name text default null::text)
 returns table(id uuid, status text, decision_reason text)
 language plpgsql security definer set search_path to 'public'
as $f$
declare
  v_caller uuid := auth.uid();
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_key text := public.payout_destination_key(p_method, p_momo_number, p_bank_name, p_bank_account_number);
  v_type text := case when lower(coalesce(p_method,'')) = 'mobile_money' then 'mobile_money' else 'bank_transfer' end;
  v_name text := coalesce(nullif(btrim(coalesce(p_momo_name,'')), ''), nullif(btrim(coalesce(p_bank_account_name,'')), ''));
  v_id uuid;
  v_status text;
  v_reason text;
  v_prev_name text;
  v_id_name text;
  v_nid text;
  v_report jsonb;
  v_still_matches boolean;
  v_exempt boolean := public.is_partner_not_agent(p_user_id);
begin
  if not v_service then
    if v_caller is null then raise exception 'not authenticated' using errcode = '42501'; end if;
    if p_user_id is distinct from v_caller and not public.is_financial_ops_staff(v_caller) then
      raise exception 'you can only register your own payout destination' using errcode = '42501';
    end if;
  end if;

  if v_key is null then
    return;
  end if;

  select p.national_id, coalesce(p.national_id_name, p.full_name)
    into v_nid, v_id_name
  from public.profiles p where p.id = p_user_id;

  v_report := public.payout_name_match_report(v_id_name, v_name);
  v_still_matches := (v_report->>'score') is null or coalesce((v_report->>'subset_match')::boolean, false);

  select d.id, d.status, d.account_name into v_id, v_status, v_prev_name
  from public.payout_destination_verifications d
  where d.user_id = p_user_id and d.destination_key = v_key;

  if v_id is null then
    insert into public.payout_destination_verifications (
      user_id, destination_type, destination_key, provider,
      momo_number, bank_name, bank_account_number, account_name,
      national_id, national_id_name, name_match_score, name_mismatch_tokens,
      status, decision_reason
    ) values (
      p_user_id, v_type, v_key,
      case when v_type = 'mobile_money' then lower(coalesce(p_provider,'')) else 'bank' end,
      case when v_type = 'mobile_money' then btrim(p_momo_number) end,
      case when v_type = 'bank_transfer' then btrim(p_bank_name) end,
      case when v_type = 'bank_transfer' then btrim(p_bank_account_number) end,
      v_name, v_nid, v_id_name,
      (v_report->>'score')::numeric, coalesce(v_report->'diff', '[]'::jsonb),
      case when v_exempt then 'verified' else 'waiting' end,
      case when v_exempt then 'Auto-verified: partner with no agent activity is exempt from manual payout-destination verification.' else null end
    )
    returning payout_destination_verifications.id, payout_destination_verifications.status,
              payout_destination_verifications.decision_reason
      into v_id, v_status, v_reason;
  else
    update public.payout_destination_verifications d
    set account_name = coalesce(v_name, d.account_name),
        national_id = coalesce(v_nid, d.national_id),
        national_id_name = coalesce(v_id_name, d.national_id_name),
        name_match_score = (v_report->>'score')::numeric,
        name_mismatch_tokens = coalesce(v_report->'diff', '[]'::jsonb),
        status = case
          when v_exempt and d.status = 'waiting' then 'verified'
          when d.status = 'verified'
               and v_name is not null
               and not v_still_matches
               and not v_exempt then 'waiting'
          when d.status = 'rejected' and not v_exempt then 'waiting'
          else d.status end,
        decision_reason = case
          when v_exempt and d.status = 'waiting' then 'Auto-verified: partner with no agent activity is exempt from manual payout-destination verification.'
          when d.status = 'verified'
               and v_name is not null
               and not v_still_matches
               and not v_exempt
          then 'Registered name no longer matches the verified identity — needs re-verification'
          when d.status = 'rejected' and not v_exempt
          then 'Resubmitted after rejection — needs Financial Ops re-review.'
          else d.decision_reason end
    where d.id = v_id
    returning d.status, d.decision_reason into v_status, v_reason;
  end if;

  return query select v_id, v_status, v_reason;
end;
$f$;

create or replace function public.enroll_welile_home_tenant(p_tenant_id uuid, p_agent_id uuid, p_monthly_rent numeric, p_payout_day integer default 5, p_has_smartphone boolean default true, p_landlord_uses_wallet boolean default false, p_landlord_id uuid default null::uuid, p_landlord_name text default null::text, p_landlord_phone text default null::text, p_notes text default null::text)
 returns jsonb
 language plpgsql security definer set search_path to 'public'
as $f$
declare
  v_uid uuid := auth.uid();
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_staff boolean := false;
  v_landlord_id uuid := p_landlord_id;
  v_sub_id uuid;
  v_fee numeric;
  v_agent_comm numeric;
  v_welile_net numeric;
  v_landlord_net numeric;
  v_receivable numeric;
  v_payout_day int;
  v_period date;
  v_collected numeric;
  i int;
begin
  if not v_service then
    if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
    v_staff := public.is_sensitive_field_editor(v_uid)
               or exists (select 1 from public.staff_permissions sp where sp.user_id = v_uid and sp.revoked_at is null
                           and sp.permitted_dashboard = any (array['agent-ops','tenant-ops','company-ops']));
    if not v_staff then
      if not exists (select 1 from public.user_roles ur where ur.user_id = v_uid and ur.role::text = any (array['agent','senior_agent','sub_agent'])) then
        raise exception 'only agents can enroll Welile Homes tenants' using errcode = '42501';
      end if;
      if p_agent_id is distinct from v_uid then
        raise exception 'you can only enroll tenants under your own agent account' using errcode = '42501';
      end if;
      if exists (select 1 from public.welile_homes_subscriptions s where s.tenant_id = p_tenant_id and s.agent_id is distinct from v_uid) then
        raise exception 'this tenant is already enrolled under another agent' using errcode = '42501';
      end if;
      v_landlord_id := null;   -- the landlord wallet payee can only be set by staff
    end if;
  end if;

  if p_monthly_rent is null or p_monthly_rent <= 0 then
    return jsonb_build_object('success', false, 'error', 'Monthly rent must be greater than zero');
  end if;
  if p_tenant_id is null or p_agent_id is null then
    return jsonb_build_object('success', false, 'error', 'Tenant and agent are required');
  end if;

  v_payout_day    := least(greatest(coalesce(p_payout_day, 5), 1), 28);
  v_fee           := round(p_monthly_rent * 0.10, 2);
  v_agent_comm    := round(p_monthly_rent * 0.02, 2);
  v_welile_net    := v_fee - v_agent_comm;
  v_landlord_net  := p_monthly_rent - v_fee;
  v_receivable    := round(p_monthly_rent * 12, 2);

  insert into public.welile_homes_subscriptions (
    tenant_id, landlord_id, monthly_rent, subscription_status,
    agent_id, enrolled_by, has_smartphone, landlord_uses_wallet, payout_day,
    monthly_landlord_fee, receivable_total, outstanding_balance,
    mode, landlord_name, landlord_phone, notes
  ) values (
    p_tenant_id,
    case when p_landlord_uses_wallet then v_landlord_id else null end,
    p_monthly_rent, 'active',
    p_agent_id, p_agent_id, p_has_smartphone, p_landlord_uses_wallet, v_payout_day,
    v_fee, v_receivable, v_receivable,
    'agent_collection', p_landlord_name, p_landlord_phone, p_notes
  )
  on conflict (tenant_id) do update set
    landlord_id          = excluded.landlord_id,
    monthly_rent         = excluded.monthly_rent,
    subscription_status  = 'active',
    agent_id             = excluded.agent_id,
    has_smartphone       = excluded.has_smartphone,
    landlord_uses_wallet = excluded.landlord_uses_wallet,
    payout_day           = excluded.payout_day,
    monthly_landlord_fee = excluded.monthly_landlord_fee,
    receivable_total     = excluded.receivable_total,
    mode                 = 'agent_collection',
    landlord_name        = excluded.landlord_name,
    landlord_phone       = excluded.landlord_phone,
    notes                = excluded.notes,
    updated_at           = now()
  returning id into v_sub_id;

  -- Generate the 12-month receivable schedule (idempotent)
  for i in 0..11 loop
    v_period := (date_trunc('month', current_date) + (i || ' months')::interval)::date;
    insert into public.welile_homes_monthly_dues (
      subscription_id, tenant_id, landlord_id, agent_id,
      period_month, payout_date,
      amount_due, landlord_fee, agent_commission, welile_net, landlord_net
    ) values (
      v_sub_id, p_tenant_id,
      case when p_landlord_uses_wallet then v_landlord_id else null end,
      p_agent_id,
      v_period, (v_period + (v_payout_day - 1)),
      p_monthly_rent, v_fee, v_agent_comm, v_welile_net, v_landlord_net
    )
    on conflict (subscription_id, period_month) do nothing;
  end loop;

  -- Recompute outstanding from schedule minus what's already collected
  select coalesce(sum(amount_collected), 0) into v_collected
  from public.welile_homes_monthly_dues where subscription_id = v_sub_id;

  update public.welile_homes_subscriptions
  set outstanding_balance = greatest(0, v_receivable - v_collected),
      next_due_date = (select min(payout_date) from public.welile_homes_monthly_dues
                       where subscription_id = v_sub_id and collection_status <> 'collected'),
      updated_at = now()
  where id = v_sub_id;

  begin
    insert into public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
    values ('agent_collection', p_agent_id, 'welile_homes_subscription', v_sub_id,
      jsonb_build_object('action','enroll','tenant_id',p_tenant_id,'monthly_rent',p_monthly_rent,'receivable_total',v_receivable));
  exception when others then null;
  end;

  return jsonb_build_object(
    'success', true,
    'subscription_id', v_sub_id,
    'monthly_rent', p_monthly_rent,
    'receivable_total', v_receivable,
    'monthly_landlord_fee', v_fee,
    'agent_commission_per_month', v_agent_comm,
    'landlord_net_per_month', v_landlord_net
  );
end;
$f$;

create or replace function public.welile_home_record_collection(p_subscription_id uuid, p_amount numeric, p_source text default 'tenant_wallet'::text, p_notes text default null::text)
 returns jsonb
 language plpgsql security definer set search_path to 'public'
as $f$
declare
  v_uid uuid := auth.uid();
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_tenant_id uuid;
  v_agent_id uuid;
  v_landlord_id uuid;
  v_outstanding numeric;
  v_monthly_rent numeric;
  v_cap numeric;
  v_agent_comm numeric;
  v_remaining numeric;
  v_take numeric;
  v_room numeric;
  v_due record;
  v_legs jsonb;
  v_txn uuid;
  v_key text;
  v_strict_float numeric := 0;
  v_tenant_avail numeric := 0;
begin
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'Amount must be greater than zero');
  end if;
  if p_source not in ('tenant_wallet','agent_allocation') then
    return jsonb_build_object('success', false, 'error', 'Invalid source');
  end if;

  select tenant_id, agent_id, landlord_id, outstanding_balance, monthly_rent
  into v_tenant_id, v_agent_id, v_landlord_id, v_outstanding, v_monthly_rent
  from public.welile_homes_subscriptions
  where id = p_subscription_id and mode = 'agent_collection';

  if v_tenant_id is null then
    return jsonb_build_object('success', false, 'error', 'Welile Homes subscription not found');
  end if;

  -- Whose money moves must be the caller's: the agent allocates their own float, the tenant pays from their own wallet.
  if not v_service then
    if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
    if p_source = 'agent_allocation' then
      if v_agent_id is distinct from v_uid then
        raise exception 'only the managing agent can allocate rent for this subscription' using errcode = '42501';
      end if;
    else
      if v_tenant_id is distinct from v_uid then
        raise exception 'only the tenant can pay rent from their own wallet' using errcode = '42501';
      end if;
    end if;
  end if;

  if coalesce(v_outstanding, 0) <= 0 then
    return jsonb_build_object('success', false, 'error', 'No outstanding balance to collect');
  end if;

  v_cap := least(p_amount, v_outstanding);

  -- Source-specific balance guards
  if p_source = 'tenant_wallet' then
    select greatest(0, coalesce(total_visible, 0)) into v_tenant_avail
    from public.wallet_strict_for_user(v_tenant_id);
    if v_tenant_avail < v_cap then
      return jsonb_build_object('success', false, 'error_code', 'INSUFFICIENT_TENANT_BALANCE',
        'error', format('Tenant wallet balance (%s) is less than the amount to collect (%s)', v_tenant_avail, v_cap));
    end if;
  else
    if v_agent_id is null then
      return jsonb_build_object('success', false, 'error', 'No managing agent for allocation');
    end if;
    select greatest(0, coalesce(float_balance, 0)) into v_strict_float
    from public.wallet_strict_for_user(v_agent_id);
    if v_strict_float < v_cap then
      return jsonb_build_object('success', false, 'error_code', 'INSUFFICIENT_FLOAT',
        'error', format('Agent float (%s) is less than the amount to allocate (%s)', v_strict_float, v_cap));
    end if;
  end if;

  v_agent_comm := round(v_cap * 0.02, 2);

  v_key := format('welile_home_collect:%s:%s:%s:%s:%s',
    p_subscription_id, p_source, v_cap, extract(epoch from clock_timestamp())::text, gen_random_uuid()::text);

  if p_source = 'tenant_wallet' then
    v_legs := jsonb_build_array(
      jsonb_build_object('user_id',v_tenant_id,'amount',v_cap,'direction','cash_out','category','rent_repayment','ledger_scope','wallet','classification','production','description','Welile Homes rent collected from tenant wallet','linked_party',v_landlord_id,'source_table','welile_homes_monthly_dues','source_id',p_subscription_id),
      jsonb_build_object('user_id',v_tenant_id,'amount',v_cap,'direction','cash_in','category','landlord_receivable_collected','ledger_scope','platform','classification','production','description','Welile Homes rent received','linked_party',v_landlord_id,'source_table','welile_homes_subscriptions','source_id',p_subscription_id)
    );
  else
    v_legs := jsonb_build_array(
      jsonb_build_object('user_id',v_agent_id,'amount',v_cap,'direction','cash_out','category','rent_payment_for_tenant','ledger_scope','wallet','classification','production','description','Welile Homes rent allocated from agent float','linked_party',v_landlord_id,'recipient_type','operational_wallet','source_table','welile_homes_monthly_dues','source_id',p_subscription_id),
      jsonb_build_object('user_id',v_agent_id,'amount',v_cap,'direction','cash_in','category','landlord_receivable_collected','ledger_scope','platform','classification','production','description','Welile Homes rent received (agent-allocated)','linked_party',v_landlord_id,'source_table','welile_homes_subscriptions','source_id',p_subscription_id)
    );
  end if;

  -- Agent 2% commission (out of Welile's 10%)
  if v_agent_id is not null and v_agent_comm > 0 then
    v_legs := v_legs || jsonb_build_array(
      jsonb_build_object('user_id',v_agent_id,'amount',v_agent_comm,'direction','cash_out','category','agent_commission_payable','ledger_scope','platform','classification','production','description','Welile Homes 2% agent commission (platform)','source_table','welile_homes_subscriptions','source_id',p_subscription_id),
      jsonb_build_object('user_id',v_agent_id,'amount',v_agent_comm,'direction','cash_in','category','agent_commission_earned','ledger_scope','wallet','classification','production','description','Welile Homes 2% agent commission','recipient_type','user','source_table','welile_homes_subscriptions','source_id',p_subscription_id)
    );
  end if;

  v_txn := public.create_ledger_transaction(v_legs, v_key, true);

  -- Apply collected amount to earliest open dues (FIFO)
  v_remaining := v_cap;
  for v_due in
    select id, amount_due, amount_collected
    from public.welile_homes_monthly_dues
    where subscription_id = p_subscription_id and collection_status <> 'collected'
    order by period_month
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
    values ('payment_made', v_tenant_id, 'welile_homes_subscription', p_subscription_id,
      jsonb_build_object('action','collection','source',p_source,'amount',v_cap,'agent_commission',v_agent_comm,'txn',v_txn));
  exception when others then null;
  end;

  return jsonb_build_object(
    'success', true,
    'transaction_group', v_txn,
    'amount_collected', v_cap,
    'agent_commission', v_agent_comm,
    'source', p_source
  );
end;
$f$;
