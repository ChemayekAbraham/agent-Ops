create or replace function public.welile_mission_empty_houses(p_since timestamptz default null)
returns table (
  listing_id uuid,
  title text,
  status text,
  monthly_rent integer,
  number_of_rooms integer,
  area text,
  region text,
  district text,
  created_at timestamptz,
  last_activity timestamptz,
  verified boolean,
  landlord_id uuid,
  landlord_name text,
  landlord_phone text,
  agent_id uuid,
  agent_name text,
  agent_phone text
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_ops_role(auth.uid()) then
    raise exception 'Not authorized';
  end if;

  return query
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
  order by coalesce(h.monthly_rent, 0) desc,
           greatest(h.created_at, coalesce(h.updated_at, h.created_at)) desc
  limit 500;
end;
$$;

grant execute on function public.welile_mission_empty_houses(timestamptz) to authenticated, service_role;