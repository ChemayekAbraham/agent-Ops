CREATE OR REPLACE FUNCTION public.welile_mission_empty_houses(p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(listing_id uuid, title text, status text, monthly_rent integer, number_of_rooms integer, area text, region text, district text, created_at timestamp with time zone, last_activity timestamp with time zone, verified boolean, landlord_id uuid, landlord_name text, landlord_phone text, agent_id uuid, agent_name text, agent_phone text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_ops_role(auth.uid()) then
    raise exception 'Not authorized';
  end if;

  return query
  -- Listed vacant houses
  select
    h.id,
    h.title,
    h.status,
    h.monthly_rent,
    h.number_of_rooms,
    nullif(btrim(concat_ws(', ',
      nullif(btrim(coalesce(h.village,'')), ''),
      nullif(btrim(coalesce(h.sub_county,'')), ''),
      nullif(btrim(coalesce(h.district,'')), ''),
      nullif(btrim(coalesce(h.region,'')), '')
    )), '') as area,
    h.region,
    h.district,
    h.created_at,
    greatest(h.created_at, coalesce(h.updated_at, h.created_at)) as last_activity,
    coalesce(h.verified, false),
    h.landlord_id,
    ll.name,
    ll.phone,
    h.agent_id,
    ap.full_name,
    ap.phone
  from house_listings h
  left join landlords ll on ll.id = h.landlord_id
  left join profiles ap on ap.id = h.agent_id
  where h.tenant_id is null
    and coalesce(h.status,'') <> 'rejected'
    and coalesce(h.is_hidden, false) = false
    and (p_since is null or h.created_at >= p_since)

  union all

  -- Unlisted landlords (registered by an agent, no tenant, no house listing yet)
  select
    l.id,
    nullif(btrim(coalesce(l.property_address,'')), '') as title,
    'unlisted'::text as status,
    coalesce(l.monthly_rent, l.desired_rent_from_welile, 0)::integer,
    l.number_of_rooms,
    nullif(btrim(concat_ws(', ',
      nullif(btrim(coalesce(l.village,'')), ''),
      nullif(btrim(coalesce(l.sub_county,'')), ''),
      nullif(btrim(coalesce(l.district,'')), ''),
      nullif(btrim(coalesce(l.region,'')), '')
    )), '') as area,
    l.region,
    l.district,
    l.created_at,
    greatest(l.created_at, coalesce(l.updated_at, l.created_at)) as last_activity,
    coalesce(l.verified, false),
    l.id,
    l.name,
    l.phone,
    l.registered_by,
    lp.full_name,
    lp.phone
  from landlords l
  left join profiles lp on lp.id = l.registered_by
  where l.registered_by is not null
    and l.tenant_id is null
    and not exists (select 1 from house_listings h2 where h2.landlord_id = l.id)
    and (p_since is null or l.created_at >= p_since)

  order by monthly_rent desc nulls last,
           last_activity desc
  limit 3000;
end;
$function$;