-- Country -> continent mapping (immutable helper)
create or replace function public.country_to_continent(p_country text)
returns text language sql immutable as $$
  select case
    when p_country is null or btrim(p_country) = '' then 'Unspecified'
    when lower(btrim(p_country)) in (
      'uganda','kenya','tanzania','rwanda','burundi','south sudan','ethiopia','eritrea','djibouti','somalia','sudan',
      'madagascar','mauritius','seychelles','comoros','mayotte','reunion','malawi','zambia','zimbabwe','mozambique',
      'nigeria','ghana','senegal','ivory coast','cote d''ivoire','côte d''ivoire','mali','burkina faso','benin','togo',
      'guinea','guinea-bissau','sierra leone','liberia','gambia','the gambia','mauritania','niger','cape verde','cabo verde','saint helena',
      'south africa','namibia','botswana','lesotho','eswatini','swaziland','angola',
      'egypt','libya','tunisia','algeria','morocco','western sahara',
      'dr congo','democratic republic of the congo','congo','republic of the congo','cameroon',
      'central african republic','central african rep.','chad','gabon','equatorial guinea','sao tome and principe'
    ) then 'Africa'
    when lower(btrim(p_country)) in (
      'united states','usa','united states of america','canada','mexico','guatemala','cuba','jamaica','haiti','panama','costa rica'
    ) then 'North America'
    when lower(btrim(p_country)) in (
      'brazil','argentina','chile','colombia','peru','venezuela','ecuador','bolivia','paraguay','uruguay'
    ) then 'South America'
    when lower(btrim(p_country)) in (
      'united kingdom','uk','england','ireland','france','germany','spain','italy','portugal','netherlands','belgium',
      'sweden','norway','denmark','finland','poland','greece','switzerland','austria','russia','ukraine','romania'
    ) then 'Europe'
    when lower(btrim(p_country)) in (
      'china','india','japan','south korea','korea','indonesia','pakistan','bangladesh','philippines','vietnam','thailand',
      'malaysia','singapore','saudi arabia','united arab emirates','uae','qatar','turkey','israel','iran','iraq'
    ) then 'Asia'
    when lower(btrim(p_country)) in ('australia','new zealand','fiji','papua new guinea') then 'Oceania'
    else 'Other'
  end
$$;

grant execute on function public.country_to_continent(text) to authenticated, anon, service_role;

-- Geographic + agent breakdown of new activity counters
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
  total_count bigint
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_ops_role(auth.uid()) then
    raise exception 'Not authorized';
  end if;

  return query
  with raw as (
    select rr.agent_id as a_id, rr.created_at as ts, 'rent'::text as kind
      from rent_requests rr where rr.agent_id is not null
    union all
    select l.registered_by, l.created_at, 'landlord'
      from landlords l where l.registered_by is not null
    union all
    select p.referrer_id, p.created_at, 'agent'
      from profiles p
      join user_roles ur on ur.user_id = p.id and ur.role = 'agent'
      join user_roles rar on rar.user_id = p.referrer_id and rar.role = 'agent'
      where p.referrer_id is not null
    union all
    select pn.agent_id, pn.created_at, 'promissory'
      from promissory_notes pn where pn.agent_id is not null
  ),
  ev as (
    select
      raw.kind,
      raw.a_id,
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
    count(*) as total_count
  from filtered
  group by 1, 2, 3
  order by total_count desc;
end;
$$;

grant execute on function public.welile_ops_counter_breakdown(text, text, text, text, timestamptz) to authenticated, service_role;

-- Source list behind a given agent's counter
create or replace function public.welile_ops_counter_items(
  p_agent_id uuid,
  p_kind text,
  p_since timestamptz default null
)
returns table (
  item_id uuid,
  profile_id uuid,
  title text,
  subtitle text,
  created_at timestamptz,
  drawer_tab text
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_ops_role(auth.uid()) then
    raise exception 'Not authorized';
  end if;

  if p_kind = 'rent' then
    return query
      select rr.id, rr.tenant_id, coalesce(tp.full_name, 'Tenant'),
             'Rent Plan · UGX ' || coalesce(rr.rent_amount, 0)::text || ' · ' || coalesce(rr.status, ''),
             rr.created_at, 'tenant'::text
      from rent_requests rr
      left join profiles tp on tp.id = rr.tenant_id
      where rr.agent_id = p_agent_id and (p_since is null or rr.created_at >= p_since)
      order by rr.created_at desc limit 500;
  elsif p_kind = 'landlord' then
    return query
      select l.id, l.id, coalesce(l.name, 'Landlord'),
             coalesce(l.phone, 'Landlord'), l.created_at, 'landlord'::text
      from landlords l
      where l.registered_by = p_agent_id and (p_since is null or l.created_at >= p_since)
      order by l.created_at desc limit 500;
  elsif p_kind = 'agent' then
    return query
      select p.id, p.id, coalesce(p.full_name, 'Agent'),
             coalesce(p.phone, 'Agent'), p.created_at, 'agent'::text
      from profiles p
      join user_roles ur on ur.user_id = p.id and ur.role = 'agent'
      where p.referrer_id = p_agent_id and (p_since is null or p.created_at >= p_since)
      order by p.created_at desc limit 500;
  elsif p_kind = 'promissory' then
    return query
      select pn.id, pn.partner_user_id, coalesce(pn.partner_name, 'Partner'),
             'Promissory · UGX ' || coalesce(pn.amount, 0)::text || ' · ' || coalesce(pn.status, ''),
             pn.created_at, 'tenant'::text
      from promissory_notes pn
      where pn.agent_id = p_agent_id and (p_since is null or pn.created_at >= p_since)
      order by pn.created_at desc limit 500;
  end if;
end;
$$;

grant execute on function public.welile_ops_counter_items(uuid, text, timestamptz) to authenticated, service_role;