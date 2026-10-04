-- Welile Mission Board: priority funnel (list empty houses -> place tenants -> onboard funders)

create or replace function public.welile_mission_summary(p_since timestamptz default null)
returns table (
  empty_houses_total bigint,
  listings_new bigint,
  listing_agents bigint,
  placements_new bigint,
  placements_total bigint,
  placement_agents bigint,
  promissory_new bigint,
  promissory_total bigint,
  promissory_activated bigint,
  promissory_amount numeric
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
    (select count(*) from house_listings
       where tenant_id is not null
         and (p_since is null or coalesce(placement_bonus_paid_at, updated_at) >= p_since)),
    (select count(*) from house_listings where tenant_id is not null),
    (select count(distinct agent_id) from house_listings
       where agent_id is not null and tenant_id is not null
         and (p_since is null or coalesce(placement_bonus_paid_at, updated_at) >= p_since)),
    (select count(*) from promissory_notes where (p_since is null or created_at >= p_since)),
    (select count(*) from promissory_notes),
    (select count(*) from promissory_notes
       where partner_user_id is not null or coalesce(status,'') in ('active','activated','approved')),
    (select coalesce(sum(amount),0) from promissory_notes where (p_since is null or created_at >= p_since));
end;
$$;

grant execute on function public.welile_mission_summary(timestamptz) to authenticated, service_role;

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
      count(*) filter (where tenant_id is not null) as placements_count,
      max(greatest(created_at, coalesce(updated_at, created_at))) as last_at
    from house_listings
    where agent_id is not null and coalesce(status,'') <> 'rejected'
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
    select agent_id from pn
  )
  select
    i.agent_id,
    p.full_name,
    p.phone,
    coalesce(hl.listings_count, 0),
    coalesce(hl.empty_listings, 0),
    coalesce(hl.placements_count, 0),
    coalesce(pn.promissory_count, 0),
    coalesce(pn.promissory_amount, 0),
    greatest(hl.last_at, pn.last_at)
  from ids i
  join profiles p on p.id = i.agent_id
  left join hl on hl.agent_id = i.agent_id
  left join pn on pn.agent_id = i.agent_id
  order by
    coalesce(hl.listings_count,0) + coalesce(hl.placements_count,0) + coalesce(pn.promissory_count,0) desc,
    greatest(hl.last_at, pn.last_at) desc nulls last
  limit 200;
end;
$$;

grant execute on function public.welile_mission_leaderboard(timestamptz) to authenticated, service_role;