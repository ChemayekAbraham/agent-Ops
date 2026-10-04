-- Mission Board: surface real placed tenants (landlords linked to tenants) and funders (Partner Ops portfolios + promissory notes)

drop function if exists public.welile_mission_summary(timestamptz);

-- 1) Rework summary to use real placement + funder sources
create or replace function public.welile_mission_summary(p_since timestamptz default null)
returns table (
  empty_houses_total bigint,
  listings_new bigint,
  listing_agents bigint,
  placements_new bigint,
  placements_total bigint,
  placement_agents bigint,
  funders_new bigint,
  funders_total bigint,
  funders_activated bigint,
  funders_amount numeric
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_ops_role(auth.uid()) then
    raise exception 'Not authorized';
  end if;

  return query
  select
    (select count(*) from house_listings
       where tenant_id is null and coalesce(status,'') <> 'rejected' and coalesce(is_hidden,false) = false),
    (select count(*) from house_listings
       where coalesce(status,'') <> 'rejected' and (p_since is null or created_at >= p_since)),
    (select count(distinct agent_id) from house_listings
       where agent_id is not null and coalesce(status,'') <> 'rejected' and (p_since is null or created_at >= p_since)),
    (select count(*) from landlords
       where tenant_id is not null and (p_since is null or created_at >= p_since)),
    (select count(*) from landlords where tenant_id is not null),
    (select count(distinct registered_by) from landlords
       where tenant_id is not null and registered_by is not null
         and (p_since is null or created_at >= p_since)),
    (select count(*) from investor_portfolios where (p_since is null or created_at >= p_since))
      + (select count(*) from promissory_notes where (p_since is null or created_at >= p_since)),
    (select count(*) from investor_portfolios)
      + (select count(*) from promissory_notes),
    (select count(*) from investor_portfolios where coalesce(cfo_verified,false) = true)
      + (select count(*) from promissory_notes
           where partner_user_id is not null or coalesce(status,'') in ('active','activated','approved')),
    (select coalesce(sum(investment_amount),0) from investor_portfolios where (p_since is null or created_at >= p_since))
      + (select coalesce(sum(amount),0) from promissory_notes where (p_since is null or created_at >= p_since));
end;
$$;

grant execute on function public.welile_mission_summary(timestamptz) to authenticated, service_role;

-- 2) Placed tenants list (occupied houses): landlords linked to a tenant
create or replace function public.welile_mission_placements(p_since timestamptz default null)
returns table (
  landlord_id uuid,
  landlord_name text,
  landlord_phone text,
  property_address text,
  monthly_rent numeric,
  verified boolean,
  tenant_id uuid,
  tenant_name text,
  tenant_phone text,
  agent_id uuid,
  agent_name text,
  agent_phone text,
  created_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_ops_role(auth.uid()) then
    raise exception 'Not authorized';
  end if;

  return query
  select
    l.id,
    l.name,
    l.phone,
    l.property_address,
    l.monthly_rent,
    coalesce(l.verified, false),
    l.tenant_id,
    tp.full_name,
    tp.phone,
    l.registered_by,
    ap.full_name,
    ap.phone,
    l.created_at
  from landlords l
  left join profiles tp on tp.id = l.tenant_id
  left join profiles ap on ap.id = l.registered_by
  where l.tenant_id is not null
    and (p_since is null or l.created_at >= p_since)
  order by l.created_at desc
  limit 500;
end;
$$;

grant execute on function public.welile_mission_placements(timestamptz) to authenticated, service_role;

-- 3) Funders list: Partner Ops portfolios + promissory notes
create or replace function public.welile_mission_funders(p_since timestamptz default null)
returns table (
  funder_key text,
  source text,
  name text,
  phone text,
  amount numeric,
  status text,
  activated boolean,
  reference text,
  agent_id uuid,
  agent_name text,
  investor_id uuid,
  created_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_ops_role(auth.uid()) then
    raise exception 'Not authorized';
  end if;

  return query
  select * from (
    select
      'portfolio:' || ip.id::text as funder_key,
      'portfolio'::text as source,
      coalesce(inv.full_name, ip.account_name, 'Funder') as name,
      coalesce(inv.phone, ip.mobile_money_number) as phone,
      ip.investment_amount as amount,
      ip.status as status,
      coalesce(ip.cfo_verified, false) as activated,
      ip.portfolio_code as reference,
      ip.agent_id as agent_id,
      ap.full_name as agent_name,
      ip.investor_id as investor_id,
      ip.created_at as created_at
    from investor_portfolios ip
    left join profiles inv on inv.id = ip.investor_id
    left join profiles ap on ap.id = ip.agent_id
    where (p_since is null or ip.created_at >= p_since)

    union all

    select
      'promissory:' || pn.id::text,
      'promissory'::text,
      coalesce(pn.partner_name, 'Funder'),
      coalesce(pn.phone_number, pn.whatsapp_number),
      pn.amount,
      pn.status,
      (pn.partner_user_id is not null or coalesce(pn.status,'') in ('active','activated','approved')),
      null::text,
      pn.agent_id,
      ap2.full_name,
      pn.partner_user_id,
      pn.created_at
    from promissory_notes pn
    left join profiles ap2 on ap2.id = pn.agent_id
    where (p_since is null or pn.created_at >= p_since)
  ) u
  order by u.created_at desc
  limit 500;
end;
$$;

grant execute on function public.welile_mission_funders(timestamptz) to authenticated, service_role;