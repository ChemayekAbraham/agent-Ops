-- Mission Board: base Priority 2 (placed tenants) on the real agent → tenant → landlord chain in rent_requests,
-- and feed a driving-force Agent Network view across all 3 priorities.

drop function if exists public.welile_mission_summary(timestamptz);

-- Placed tenant = rent_request that reached an active tenancy (funded / repaying / completed).
-- Each one is an agent who placed a tenant into a landlord's house.
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
    (select count(distinct tenant_id) from rent_requests
       where status in ('funded','repaying','completed') and tenant_id is not null
         and (p_since is null or created_at >= p_since)),
    (select count(distinct tenant_id) from rent_requests
       where status in ('funded','repaying','completed') and tenant_id is not null),
    (select count(distinct agent_id) from rent_requests
       where status in ('funded','repaying','completed') and agent_id is not null
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

-- Placed tenants drill-down: from rent_requests (agent placed tenant into landlord's house)
drop function if exists public.welile_mission_placements(timestamptz);
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
    coalesce(l.monthly_rent, rr.rent_amount),
    coalesce(l.verified, false),
    rr.tenant_id,
    tp.full_name,
    tp.phone,
    rr.agent_id,
    ap.full_name,
    ap.phone,
    rr.created_at
  from rent_requests rr
  left join landlords l on l.id = rr.landlord_id
  left join profiles tp on tp.id = rr.tenant_id
  left join profiles ap on ap.id = rr.agent_id
  where rr.status in ('funded','repaying','completed')
    and rr.tenant_id is not null
    and (p_since is null or rr.created_at >= p_since)
  order by rr.created_at desc
  limit 500;
end;
$$;

grant execute on function public.welile_mission_placements(timestamptz) to authenticated, service_role;

-- Leaderboard: placements now come from real rent_requests placements per agent
drop function if exists public.welile_mission_leaderboard(timestamptz);
create or replace function public.welile_mission_leaderboard(p_since timestamptz default null)
returns table (
  agent_id uuid,
  agent_name text,
  agent_phone text,
  listings_count bigint,
  empty_listings bigint,
  placements_count bigint,
  promissory_count bigint,
  promissory_amount numeric,
  last_activity timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_ops_role(auth.uid()) then
    raise exception 'Not authorized';
  end if;

  return query
  with hl as (
    select agent_id,
      count(*) as listings_count,
      count(*) filter (where tenant_id is null) as empty_listings,
      max(greatest(created_at, coalesce(updated_at, created_at))) as last_at
    from house_listings
    where agent_id is not null and coalesce(status,'') <> 'rejected'
      and (p_since is null or greatest(created_at, coalesce(updated_at, created_at)) >= p_since)
    group by agent_id
  ),
  pl as (
    select agent_id,
      count(distinct tenant_id) as placements_count,
      max(greatest(created_at, coalesce(updated_at, created_at))) as last_at
    from rent_requests
    where agent_id is not null and status in ('funded','repaying','completed')
      and (p_since is null or greatest(created_at, coalesce(updated_at, created_at)) >= p_since)
    group by agent_id
  ),
  pn as (
    select agent_id,
      count(*) as promissory_count,
      coalesce(sum(amount),0) as promissory_amount,
      max(created_at) as last_at
    from promissory_notes
    where agent_id is not null and (p_since is null or created_at >= p_since)
    group by agent_id
  ),
  ids as (
    select agent_id from hl
    union
    select agent_id from pl
    union
    select agent_id from pn
  )
  select
    i.agent_id,
    p.full_name,
    p.phone,
    coalesce(hl.listings_count, 0),
    coalesce(hl.empty_listings, 0),
    coalesce(pl.placements_count, 0),
    coalesce(pn.promissory_count, 0),
    coalesce(pn.promissory_amount, 0),
    greatest(hl.last_at, pl.last_at, pn.last_at)
  from ids i
  join profiles p on p.id = i.agent_id
  left join hl on hl.agent_id = i.agent_id
  left join pl on pl.agent_id = i.agent_id
  left join pn on pn.agent_id = i.agent_id
  order by
    coalesce(hl.listings_count,0) + coalesce(pl.placements_count,0) + coalesce(pn.promissory_count,0) desc,
    greatest(hl.last_at, pl.last_at, pn.last_at) desc nulls last
  limit 200;
end;
$$;

grant execute on function public.welile_mission_leaderboard(timestamptz) to authenticated, service_role;

-- Agent network: aggregated driving-force stats across all 3 priorities
create or replace function public.welile_mission_agent_network(p_since timestamptz default null)
returns table (
  total_agents bigint,
  listing_agents bigint,
  placement_agents bigint,
  funder_agents bigint,
  houses_listed bigint,
  tenants_placed bigint,
  landlords_reached bigint,
  funders_total bigint,
  top_agent_id uuid,
  top_agent_name text,
  top_agent_score bigint
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_top_id uuid;
  v_top_name text;
  v_top_score bigint;
begin
  if not public.is_ops_role(auth.uid()) then
    raise exception 'Not authorized';
  end if;

  with hl as (
    select agent_id, count(*) c
    from house_listings
    where agent_id is not null and coalesce(status,'') <> 'rejected'
      and (p_since is null or created_at >= p_since)
    group by agent_id
  ),
  pl as (
    select agent_id, count(distinct tenant_id) c
    from rent_requests
    where agent_id is not null and status in ('funded','repaying','completed')
      and (p_since is null or created_at >= p_since)
    group by agent_id
  ),
  pn as (
    select agent_id, count(*) c
    from promissory_notes
    where agent_id is not null and (p_since is null or created_at >= p_since)
    group by agent_id
  ),
  combined as (
    select coalesce(hl.agent_id, pl.agent_id, pn.agent_id) as agent_id,
      coalesce(hl.c,0) + coalesce(pl.c,0) + coalesce(pn.c,0) as score
    from hl
    full join pl on pl.agent_id = hl.agent_id
    full join pn on pn.agent_id = coalesce(hl.agent_id, pl.agent_id)
  )
  select c.agent_id, p.full_name, c.score
  into v_top_id, v_top_name, v_top_score
  from combined c
  join profiles p on p.id = c.agent_id
  order by c.score desc
  limit 1;

  return query
  select
    (select count(distinct agent_id) from (
        select agent_id from house_listings where agent_id is not null and coalesce(status,'') <> 'rejected' and (p_since is null or created_at >= p_since)
        union
        select agent_id from rent_requests where agent_id is not null and status in ('funded','repaying','completed') and (p_since is null or created_at >= p_since)
        union
        select agent_id from promissory_notes where agent_id is not null and (p_since is null or created_at >= p_since)
      ) a),
    (select count(distinct agent_id) from house_listings where agent_id is not null and coalesce(status,'') <> 'rejected' and (p_since is null or created_at >= p_since)),
    (select count(distinct agent_id) from rent_requests where agent_id is not null and status in ('funded','repaying','completed') and (p_since is null or created_at >= p_since)),
    (select count(distinct agent_id) from promissory_notes where agent_id is not null and (p_since is null or created_at >= p_since)),
    (select count(*) from house_listings where coalesce(status,'') <> 'rejected' and (p_since is null or created_at >= p_since)),
    (select count(distinct tenant_id) from rent_requests where status in ('funded','repaying','completed') and tenant_id is not null and (p_since is null or created_at >= p_since)),
    (select count(distinct landlord_id) from rent_requests where status in ('funded','repaying','completed') and landlord_id is not null and (p_since is null or created_at >= p_since)),
    (select count(*) from promissory_notes where (p_since is null or created_at >= p_since)),
    v_top_id, v_top_name, coalesce(v_top_score,0);
end;
$$;

grant execute on function public.welile_mission_agent_network(timestamptz) to authenticated, service_role;