CREATE OR REPLACE FUNCTION public.wh_request_float(p_subscription_ids uuid[], p_recipient_phone text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Tenant SMS verification is no longer required for Welile Homes float requests.

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
end $function$;