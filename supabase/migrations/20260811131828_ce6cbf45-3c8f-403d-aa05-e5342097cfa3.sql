CREATE OR REPLACE FUNCTION public.welile_mission_driver_entities(p_driver text, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(entity_type text, entity_id uuid, name text, phone text, detail text, created_at timestamp with time zone, agent_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_ops_role(auth.uid()) then
    raise exception 'Not authorized';
  end if;

  if p_driver = 'list' then
    return query
    select 'agent'::text, hl.agent_id, p.full_name, p.phone,
      count(*)::text || ' listing' || case when count(*) = 1 then '' else 's' end,
      max(hl.created_at),
      hl.agent_id
    from house_listings hl
    join profiles p on p.id = hl.agent_id
    where hl.agent_id is not null and coalesce(hl.status,'') <> 'rejected'
      and (p_since is null or hl.created_at >= p_since)
    group by hl.agent_id, p.full_name, p.phone
    order by count(*) desc
    limit 300;

    return query
    select 'landlord'::text, hl.landlord_id, l.name, l.phone,
      count(*)::text || ' house' || case when count(*) = 1 then '' else 's' end,
      max(hl.created_at),
      (array_agg(hl.agent_id order by hl.created_at desc))[1]
    from house_listings hl
    join landlords l on l.id = hl.landlord_id
    where hl.landlord_id is not null and coalesce(hl.status,'') <> 'rejected'
      and (p_since is null or hl.created_at >= p_since)
    group by hl.landlord_id, l.name, l.phone
    order by count(*) desc
    limit 300;

  elsif p_driver = 'place' then
    return query
    select 'agent'::text, rr.agent_id, p.full_name, p.phone,
      count(distinct rr.tenant_id)::text || ' tenant' || case when count(distinct rr.tenant_id) = 1 then '' else 's' end,
      max(rr.created_at),
      rr.agent_id
    from rent_requests rr
    join profiles p on p.id = rr.agent_id
    where rr.agent_id is not null and rr.status in ('funded','repaying','completed')
      and (p_since is null or rr.created_at >= p_since)
    group by rr.agent_id, p.full_name, p.phone
    order by count(distinct rr.tenant_id) desc
    limit 300;

    return query
    select 'tenant'::text, rr.tenant_id, tp.full_name, tp.phone,
      count(*)::text || ' tenancy' || case when count(*) = 1 then '' else 's' end,
      max(rr.created_at),
      (array_agg(rr.agent_id order by rr.created_at desc))[1]
    from rent_requests rr
    join profiles tp on tp.id = rr.tenant_id
    where rr.tenant_id is not null and rr.status in ('funded','repaying','completed')
      and (p_since is null or rr.created_at >= p_since)
    group by rr.tenant_id, tp.full_name, tp.phone
    order by max(rr.created_at) desc
    limit 300;

    return query
    select 'landlord'::text, rr.landlord_id, l.name, l.phone,
      count(distinct rr.tenant_id)::text || ' tenant' || case when count(distinct rr.tenant_id) = 1 then '' else 's' end,
      max(rr.created_at),
      (array_agg(rr.agent_id order by rr.created_at desc))[1]
    from rent_requests rr
    join landlords l on l.id = rr.landlord_id
    where rr.landlord_id is not null and rr.status in ('funded','repaying','completed')
      and (p_since is null or rr.created_at >= p_since)
    group by rr.landlord_id, l.name, l.phone
    order by count(distinct rr.tenant_id) desc
    limit 300;

  elsif p_driver = 'fund' then
    return query
    select 'agent'::text, a.agent_id, p.full_name, p.phone,
      count(*)::text || ' funder' || case when count(*) = 1 then '' else 's' end,
      max(a.created_at),
      a.agent_id
    from (
      select agent_id, created_at from promissory_notes
        where agent_id is not null and (p_since is null or created_at >= p_since)
      union all
      select agent_id, created_at from investor_portfolios
        where agent_id is not null and (p_since is null or created_at >= p_since)
    ) a
    join profiles p on p.id = a.agent_id
    group by a.agent_id, p.full_name, p.phone
    order by count(*) desc
    limit 300;

    return query
    select * from (
      select 'funder'::text as entity_type, ip.investor_id as entity_id,
        coalesce(inv.full_name, ip.account_name, 'Funder') as name,
        coalesce(inv.phone, ip.mobile_money_number) as phone,
        'UGX ' || to_char(coalesce(ip.investment_amount,0), 'FM999,999,999') as detail,
        ip.created_at as created_at,
        ip.agent_id as agent_id
      from investor_portfolios ip
      left join profiles inv on inv.id = ip.investor_id
      where (p_since is null or ip.created_at >= p_since)

      union all

      select 'funder'::text, pn.partner_user_id,
        coalesce(pn.partner_name, 'Funder'),
        coalesce(pn.phone_number, pn.whatsapp_number),
        'UGX ' || to_char(coalesce(pn.amount,0), 'FM999,999,999'),
        pn.created_at,
        pn.agent_id
      from promissory_notes pn
      where (p_since is null or pn.created_at >= p_since)
    ) u
    order by u.created_at desc
    limit 300;
  end if;
end;
$function$;