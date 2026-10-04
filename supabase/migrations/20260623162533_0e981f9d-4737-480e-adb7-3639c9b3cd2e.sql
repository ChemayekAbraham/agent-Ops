CREATE OR REPLACE FUNCTION public.welile_mission_summary(p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(empty_houses_total bigint, listings_new bigint, listing_agents bigint, placements_new bigint, placements_total bigint, placement_agents bigint, funders_new bigint, funders_total bigint, funders_activated bigint, funders_amount numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    -- Placements counted by when the tenant was actually funded/placed
    (select count(distinct tenant_id) from rent_requests
       where status in ('funded','repaying','completed') and tenant_id is not null
         and (p_since is null or coalesce(funded_at, disbursed_at, updated_at, created_at) >= p_since)),
    (select count(distinct tenant_id) from rent_requests
       where status in ('funded','repaying','completed') and tenant_id is not null),
    (select count(distinct agent_id) from rent_requests
       where status in ('funded','repaying','completed') and agent_id is not null
         and (p_since is null or coalesce(funded_at, disbursed_at, updated_at, created_at) >= p_since)),
    (select count(*) from investor_portfolios where (p_since is null or created_at >= p_since))
      + (select count(*) from promissory_notes where (p_since is null or created_at >= p_since)),
    (select count(*) from investor_portfolios)
      + (select count(*) from promissory_notes),
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
$function$;