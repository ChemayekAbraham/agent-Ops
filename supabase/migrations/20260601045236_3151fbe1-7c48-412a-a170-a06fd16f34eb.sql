create or replace function public.welile_ops_zone_landlords(
  p_continent text default null,
  p_country text default null,
  p_city text default null,
  p_since timestamptz default null
)
returns table (
  landlord_id uuid,
  landlord_name text,
  landlord_phone text,
  registered_by uuid,
  agent_name text,
  rent_count bigint,
  rent_funded_count bigint,
  first_activity timestamptz,
  last_activity timestamptz,
  is_producing boolean
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_ops_role(auth.uid()) then
    raise exception 'Not authorized';
  end if;

  return query
  with z as (
    select
      l.id, l.name, l.phone, l.registered_by, l.created_at as reg_at,
      ap.full_name as agent_name
    from landlords l
    join profiles ap on ap.id = l.registered_by
    where l.registered_by is not null
      and (p_continent is null or public.country_to_continent(ap.country) = p_continent)
      and (p_country is null or coalesce(nullif(btrim(ap.country), ''), 'Unspecified') = p_country)
      and (p_city is null or coalesce(nullif(btrim(ap.town), ''), nullif(btrim(ap.city), ''), 'Unspecified') = p_city)
  ),
  rr as (
    select landlord_id, created_at,
      (funded_at is not null or status in ('funded','repaying','completed')) as funded
    from rent_requests
    where landlord_id is not null
  )
  select
    z.id,
    z.name,
    z.phone,
    z.registered_by,
    z.agent_name,
    count(rr.landlord_id),
    count(rr.landlord_id) filter (where rr.funded),
    least(z.reg_at, min(rr.created_at)),
    greatest(z.reg_at, max(rr.created_at)),
    bool_or(coalesce(rr.funded, false))
  from z
  left join rr on rr.landlord_id = z.id and (p_since is null or rr.created_at >= p_since)
  group by z.id, z.name, z.phone, z.registered_by, z.agent_name, z.reg_at
  having p_since is null or z.reg_at >= p_since or count(rr.landlord_id) > 0
  order by bool_or(coalesce(rr.funded, false)) desc,
           count(rr.landlord_id) filter (where rr.funded) desc,
           count(rr.landlord_id) desc
  limit 500;
end;
$$;

grant execute on function public.welile_ops_zone_landlords(text, text, text, timestamptz) to authenticated, service_role;