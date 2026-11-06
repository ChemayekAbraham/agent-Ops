CREATE OR REPLACE FUNCTION public.get_my_welile_homes_landlords(p_limit integer DEFAULT 300)
RETURNS TABLE (id uuid, name text, phone text, property_address text, description text, receipt_request_channel text,
  district text, county text, sub_county text, village text, cell text, ug_village_id integer,
  latitude numeric, longitude numeric, registered_by uuid, location_captured_by uuid, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  select l.id, l.name, l.phone, l.property_address, l.description, l.receipt_request_channel,
         l.district, l.county, l.sub_county, l.village, l.cell, l.ug_village_id,
         l.latitude, l.longitude, l.registered_by, l.location_captured_by, l.created_at
    from public.landlords l
   where (select auth.uid()) is not null
     and l.registered_by = (select auth.uid())
   order by l.created_at desc
   limit least(greatest(coalesce(p_limit, 300), 1), 1000);
$$;
REVOKE ALL ON FUNCTION public.get_my_welile_homes_landlords(integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_my_welile_homes_landlords(integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enroll_welile_home_tenant(p_tenant_id uuid, p_agent_id uuid, p_monthly_rent numeric, p_payout_day integer DEFAULT 5, p_has_smartphone boolean DEFAULT true, p_landlord_uses_wallet boolean DEFAULT false, p_landlord_id uuid DEFAULT NULL::uuid, p_landlord_name text DEFAULT NULL::text, p_landlord_phone text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;