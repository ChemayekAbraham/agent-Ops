alter table public.welile_homes_monthly_dues add column if not exists due_month_index smallint;
update public.welile_homes_monthly_dues d set due_month_index = x.rn
from (select id, row_number() over (partition by subscription_id order by period_month) rn from public.welile_homes_monthly_dues) x
where x.id = d.id and d.due_month_index is null;
alter table public.welile_homes_monthly_dues alter column due_month_index set not null;
alter table public.welile_homes_monthly_dues add constraint whmd_due_month_index_range check (due_month_index between 1 and 12);
alter table public.welile_homes_monthly_dues add constraint whmd_tenant_month_index_key unique (tenant_id, due_month_index);

CREATE OR REPLACE FUNCTION public.enroll_welile_home_tenant(p_tenant_id uuid, p_agent_id uuid, p_monthly_rent numeric, p_payout_day integer DEFAULT 5, p_has_smartphone boolean DEFAULT true, p_landlord_uses_wallet boolean DEFAULT false, p_landlord_id uuid DEFAULT NULL::uuid, p_landlord_name text DEFAULT NULL::text, p_landlord_phone text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_staff boolean := false;
  v_landlord_id uuid := p_landlord_id;
  v_sub_id uuid;
  v_fee numeric; v_agent_comm numeric; v_welile_net numeric; v_landlord_net numeric;
  v_receivable numeric; v_payout_day int; v_period date; v_collected numeric;
  v_existing int; v_start date; v_revised int := 0;
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
      if p_landlord_id is not null and not exists (
           select 1 from public.landlords l where l.id = p_landlord_id and l.registered_by = v_uid) then
        raise exception 'you can only enroll tenants under landlords you registered' using errcode = '42501';
      end if;
      if p_landlord_id is null and nullif(trim(p_landlord_phone), '') is not null
         and exists (select 1 from public.landlords l where l.phone = trim(p_landlord_phone) and l.registered_by is distinct from v_uid)
         and not exists (select 1 from public.landlords l where l.phone = trim(p_landlord_phone) and l.registered_by = v_uid) then
        raise exception 'this landlord is registered by another agent' using errcode = '42501';
      end if;
      v_landlord_id := null;
    end if;
  end if;

  if p_monthly_rent is null or p_monthly_rent <= 0 then
    return jsonb_build_object('success', false, 'error', 'Monthly rent must be greater than zero');
  end if;
  if p_tenant_id is null or p_agent_id is null then
    return jsonb_build_object('success', false, 'error', 'Tenant and agent are required');
  end if;

  -- serialize concurrent enrolments for the same tenant
  perform pg_advisory_xact_lock(hashtext('wh_enroll:' || p_tenant_id::text));

  v_payout_day    := least(greatest(coalesce(p_payout_day, 5), 1), 28);
  v_fee           := round(p_monthly_rent * 0.10, 2);
  v_agent_comm    := round(p_monthly_rent * 0.02, 2);
  v_welile_net    := v_fee - v_agent_comm;
  v_landlord_net  := p_monthly_rent - v_fee;

  insert into public.welile_homes_subscriptions (
    tenant_id, landlord_id, monthly_rent, subscription_status,
    agent_id, enrolled_by, has_smartphone, landlord_uses_wallet, payout_day,
    monthly_landlord_fee, receivable_total, outstanding_balance,
    mode, landlord_name, landlord_phone, notes
  ) values (
    p_tenant_id, case when p_landlord_uses_wallet then v_landlord_id else null end,
    p_monthly_rent, 'active', p_agent_id, p_agent_id, p_has_smartphone, p_landlord_uses_wallet, v_payout_day,
    v_fee, round(p_monthly_rent * 12, 2), round(p_monthly_rent * 12, 2),
    'agent_collection', p_landlord_name, p_landlord_phone, p_notes
  )
  on conflict (tenant_id) do update set
    landlord_id = excluded.landlord_id, monthly_rent = excluded.monthly_rent, subscription_status = 'active',
    agent_id = excluded.agent_id, has_smartphone = excluded.has_smartphone,
    landlord_uses_wallet = excluded.landlord_uses_wallet, payout_day = excluded.payout_day,
    monthly_landlord_fee = excluded.monthly_landlord_fee, mode = 'agent_collection',
    landlord_name = excluded.landlord_name, landlord_phone = excluded.landlord_phone,
    notes = excluded.notes, updated_at = now()
  returning id into v_sub_id;

  select count(*), min(period_month) into v_existing, v_start
  from public.welile_homes_monthly_dues where subscription_id = v_sub_id;

  if v_existing = 0 then
    for i in 1..12 loop
      v_period := (date_trunc('month', current_date) + ((i - 1) || ' months')::interval)::date;
      insert into public.welile_homes_monthly_dues (
        subscription_id, tenant_id, landlord_id, agent_id, due_month_index,
        period_month, payout_date, amount_due, landlord_fee, agent_commission, welile_net, landlord_net
      ) values (
        v_sub_id, p_tenant_id, case when p_landlord_uses_wallet then v_landlord_id else null end, p_agent_id, i,
        v_period, (v_period + (v_payout_day - 1)), p_monthly_rent, v_fee, v_agent_comm, v_welile_net, v_landlord_net
      );
    end loop;
  else
    -- schedule already exists: never add or duplicate months; revise only untouched dues
    update public.welile_homes_monthly_dues d set
      amount_due = p_monthly_rent, landlord_fee = v_fee, agent_commission = v_agent_comm,
      welile_net = v_welile_net, landlord_net = v_landlord_net,
      payout_date = d.period_month + (v_payout_day - 1),
      landlord_id = case when p_landlord_uses_wallet then v_landlord_id else null end,
      agent_id = p_agent_id, updated_at = now()
    where d.subscription_id = v_sub_id
      and d.collection_status = 'pending' and coalesce(d.amount_collected, 0) = 0
      and d.payout_status = 'unpaid' and d.ledger_transaction_id is null;
    get diagnostics v_revised = row_count;
  end if;

  select coalesce(sum(amount_due), 0), coalesce(sum(amount_collected), 0) into v_receivable, v_collected
  from public.welile_homes_monthly_dues where subscription_id = v_sub_id;

  update public.welile_homes_subscriptions
  set receivable_total = v_receivable,
      outstanding_balance = greatest(0, v_receivable - v_collected),
      next_due_date = (select min(payout_date) from public.welile_homes_monthly_dues
                       where subscription_id = v_sub_id and collection_status <> 'collected'),
      updated_at = now()
  where id = v_sub_id;

  begin
    insert into public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
    values ('agent_collection', p_agent_id, 'welile_homes_subscription', v_sub_id,
      jsonb_build_object('action', case when v_existing = 0 then 'enroll' else 're_enroll' end,
        'tenant_id', p_tenant_id, 'monthly_rent', p_monthly_rent, 'receivable_total', v_receivable,
        'dues_revised', v_revised));
  exception when others then null;
  end;

  return jsonb_build_object(
    'success', true, 'subscription_id', v_sub_id, 're_enrolled', v_existing > 0,
    'dues_revised', v_revised, 'monthly_rent', p_monthly_rent, 'receivable_total', v_receivable,
    'monthly_landlord_fee', v_fee, 'agent_commission_per_month', v_agent_comm,
    'landlord_net_per_month', v_landlord_net
  );
end;
$function$;