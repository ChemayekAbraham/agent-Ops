drop function if exists public.welile_ops_counter_breakdown(text, text, text, text, timestamptz);

create or replace function public.welile_ops_counter_breakdown(
  p_level text default 'continent',
  p_continent text default null,
  p_country text default null,
  p_city text default null,
  p_since timestamptz default null
)
returns table (
  bucket_key text,
  bucket_label text,
  agent_id uuid,
  rent_count bigint,
  landlord_count bigint,
  agent_count bigint,
  promissory_count bigint,
  total_count bigint,
  rent_funded_count bigint,
  distinct_agents bigint,
  active_agents bigint
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
      raw.kind,
      raw.a_id,
      raw.funded,
      ap.full_name as agent_name,
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
    case p_level
      when 'continent' then continent
      when 'country' then country
      when 'city' then city
      else a_id::text
    end as bucket_key,
    case p_level
      when 'continent' then continent
      when 'country' then country
      when 'city' then city
      else coalesce(agent_name, 'Unknown agent')
    end as bucket_label,
    case when p_level = 'agent' then a_id else null end as agent_id,
    count(*) filter (where kind = 'rent') as rent_count,
    count(*) filter (where kind = 'landlord') as landlord_count,
    count(*) filter (where kind = 'agent') as agent_count,
    count(*) filter (where kind = 'promissory') as promissory_count,
    count(*) as total_count,
    count(*) filter (where kind = 'rent' and funded) as rent_funded_count,
    count(distinct a_id) as distinct_agents,
    count(distinct a_id) filter (where funded) as active_agents
  from filtered
  group by 1, 2, 3
  order by total_count desc;
end;
$$;

grant execute on function public.welile_ops_counter_breakdown(text, text, text, text, timestamptz) to authenticated, service_role;