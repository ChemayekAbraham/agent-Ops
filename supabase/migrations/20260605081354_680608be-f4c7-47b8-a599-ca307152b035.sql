-- Update welile_mission_summary so funders_activated counts portfolio funders with ≥ UGX 10,000 total investment.
-- Promissory-note funders keep the existing status-based activation rule.

drop function if exists public.welile_mission_summary(timestamptz);

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
    -- Activated = portfolio funders with total investment ≥ UGX 10,000
    (select count(*) from (
       select investor_id from investor_portfolios
       where coalesce(cfo_verified, false) = true
       group by investor_id
       having coalesce(sum(investment_amount), 0) >= 10000
     ) x)
      + (select count(*) from promissory_notes
           where partner_user_id is not null or coalesce(status,'') in ('active','activated','approved')),
    (select coalesce(sum(investment_amount),0) from investor_portfolios where (p_since is null or created_at >= p_since))
      + (select coalesce(sum(amount),0) from promissory_notes where (p_since is null or created_at >= p_since));
end;
$$;

grant execute on function public.welile_mission_summary(timestamptz) to authenticated, service_role;