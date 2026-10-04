
-- Classify agent-registered landlords into the empty-house (P1) / placed-tenant (P2) funnel.
-- P2 (placed): landlord.tenant_id set OR a house_listing for that landlord has a tenant placed.
-- P1 (empty houses): everything else — listed-but-empty AND registered-but-no-house (unlisted) folded together.

CREATE OR REPLACE FUNCTION public.welile_landlord_priority_breakdown(
  p_since timestamp with time zone DEFAULT NULL
)
RETURNS TABLE(
  total_landlords bigint,
  priority1_empty bigint,
  priority2_placed bigint,
  p1_listed_empty bigint,
  p1_unlisted bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  if not public.is_ops_role(auth.uid()) then
    raise exception 'Not authorized';
  end if;

  return query
  with classified as (
    select
      l.id,
      (
        l.tenant_id is not null
        or exists (
          select 1 from house_listings h
          where h.landlord_id = l.id and h.tenant_id is not null
        )
      ) as placed,
      exists (select 1 from house_listings h where h.landlord_id = l.id) as has_listing
    from landlords l
    where l.registered_by is not null
      and (p_since is null or l.created_at >= p_since)
  )
  select
    count(*)::bigint,
    count(*) filter (where not placed)::bigint,
    count(*) filter (where placed)::bigint,
    count(*) filter (where not placed and has_listing)::bigint,
    count(*) filter (where not placed and not has_listing)::bigint
  from classified;
end;
$function$;

-- Drill-down: list landlords in a chosen bucket.
-- p_bucket: 'priority1' (all empty), 'priority2' (placed), 'listed_empty', 'unlisted'
CREATE OR REPLACE FUNCTION public.welile_landlord_priority_items(
  p_bucket text DEFAULT 'priority1',
  p_since timestamp with time zone DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS TABLE(
  landlord_id uuid,
  landlord_name text,
  landlord_phone text,
  property_address text,
  agent_id uuid,
  agent_name text,
  listing_count bigint,
  empty_listing_count bigint,
  placed boolean,
  created_at timestamp with time zone
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  if not public.is_ops_role(auth.uid()) then
    raise exception 'Not authorized';
  end if;

  return query
  with classified as (
    select
      l.id,
      l.name,
      l.phone,
      l.property_address,
      l.registered_by,
      l.created_at,
      (
        l.tenant_id is not null
        or exists (select 1 from house_listings h where h.landlord_id = l.id and h.tenant_id is not null)
      ) as placed,
      (select count(*) from house_listings h where h.landlord_id = l.id) as listing_count,
      (select count(*) from house_listings h where h.landlord_id = l.id and h.tenant_id is null) as empty_listing_count
    from landlords l
    where l.registered_by is not null
      and (p_since is null or l.created_at >= p_since)
  )
  select
    c.id,
    c.name,
    c.phone,
    c.property_address,
    c.registered_by,
    ap.full_name,
    c.listing_count,
    c.empty_listing_count,
    c.placed,
    c.created_at
  from classified c
  left join profiles ap on ap.id = c.registered_by
  where
    case p_bucket
      when 'priority2' then c.placed
      when 'priority1' then not c.placed
      when 'listed_empty' then (not c.placed and c.listing_count > 0)
      when 'unlisted' then (not c.placed and c.listing_count = 0)
      else not c.placed
    end
  order by c.created_at desc
  limit greatest(1, least(coalesce(p_limit, 500), 2000));
end;
$function$;

GRANT EXECUTE ON FUNCTION public.welile_landlord_priority_breakdown(timestamp with time zone) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.welile_landlord_priority_items(text, timestamp with time zone, integer) TO authenticated, service_role;
