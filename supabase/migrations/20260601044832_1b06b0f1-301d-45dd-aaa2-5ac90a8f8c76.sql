create or replace function public.welile_ops_zone_agents(
  p_continent text default null,
  p_country text default null,
  p_city text default null,
  p_since timestamptz default null
)
returns table (
  agent_id uuid,
  agent_name text,
  agent_phone text,
  rent_count bigint,
  rent_funded_count bigint,
  landlord_count bigint,
  agent_count bigint,
  promissory_count bigint,
  total_count bigint,
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
  with raw as (
    select rr.agent_id as a_id, rr.created_at as ts, 'rent'::text as kind,
           (rr.funded_at is not null or rr.status in ('funded','repaying','completed')) as funded
      from rent_requests rr where rr.agent_id is not null
    union all
    select l.registered_by, l.created_at, 'landlord', false
      from landlords l where l.registered_by is not null
    union all
    select p.referrer_id, p.created_at, 'agent', false
      from profiles p
      join user_roles ur on ur.user_id = p.id and ur.role = 'agent'
      join user_roles rar on rar.user_id = p.referrer_id and rar.role = 'agent'
      where p.referrer_id is not null
    union all
    select pn.agent_id, pn.created_at, 'promissory', false
      from promissory_notes pn where pn.agent_id is not null
  ),
  ev as (
    select
      raw.a_id, raw.ts, raw.kind, raw.funded,
      ap.full_name as agent_name,
      ap.phone as agent_phone,
      public.country_to_continent(ap.country) as continent,
      coalesce(nullif(btrim(ap.country), ''), 'Unspecified') as country,
      coalesce(nullif(btrim(ap.town), ''), nullif(btrim(ap.city), ''), 'Unspecified') as city
    from raw
    join profiles ap on ap.id = raw.a_id
    where (p_since is null or raw.ts >= p_since)
  ),
  filtered as (
    select * from ev
    where (p_continent is null or continent = p_continent)
      and (p_country is null or country = p_country)
      and (p_city is null or city = p_city)
  )
  select
    a_id,
    max(agent_name),
    max(agent_phone),
    count(*) filter (where kind = 'rent'),
    count(*) filter (where kind = 'rent' and funded),
    count(*) filter (where kind = 'landlord'),
    count(*) filter (where kind = 'agent'),
    count(*) filter (where kind = 'promissory'),
    count(*),
    min(ts),
    max(ts),
    bool_or(funded)
  from filtered
  group by a_id
  order by bool_or(funded) desc,
           count(*) filter (where kind = 'rent' and funded) desc,
           count(*) desc
  limit 500;
end;
$$;

grant execute on function public.welile_ops_zone_agents(text, text, text, timestamptz) to authenticated, service_role;