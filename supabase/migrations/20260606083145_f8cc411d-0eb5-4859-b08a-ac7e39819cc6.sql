drop function if exists public.search_landlords_fuzzy(text, int);
drop function if exists public.search_landlords_fuzzy(text, int, real);

create or replace function public.search_landlords_fuzzy(
  p_query text default '',
  p_limit int default 20,
  p_threshold real default 0.2
)
returns table (
  id uuid,
  name text,
  phone text,
  property_address text,
  district text,
  town_council text,
  county text,
  village text,
  house_category text,
  monthly_rent numeric,
  latitude numeric,
  longitude numeric,
  match_score real,
  match_kind text
)
language sql
stable
security definer
set search_path = public
as $$
  with q as (
    select
      coalesce(nullif(trim(p_query), ''), '') as term,
      regexp_replace(coalesce(p_query, ''), '\D', '', 'g') as digits,
      greatest(coalesce(p_threshold, 0.2), 0.05) as thr
  ),
  scored as (
    select
      l.id, l.name, l.phone, l.property_address, l.district, l.town_council,
      l.county, l.village, l.house_category, l.monthly_rent, l.latitude, l.longitude,
      q.term, q.digits, q.thr,
      (l.name ilike '%' || q.term || '%') as name_substr,
      (q.term <> '' and l.phone ilike '%' || q.term || '%') as phone_substr,
      (length(q.digits) >= 3 and l.phone ilike '%' || q.digits || '%') as phone_digit,
      greatest(similarity(l.name, q.term), word_similarity(q.term, l.name)) as name_sim
    from public.landlords l, q
  )
  select
    s.id, s.name, s.phone, s.property_address, s.district, s.town_council,
    s.county, s.village, s.house_category, s.monthly_rent, s.latitude, s.longitude,
    case when s.term = '' then 1::real else round(s.name_sim::numeric, 3)::real end as match_score,
    case
      when s.term = '' then 'all'
      when s.name_substr then 'name_exact'
      when s.phone_substr or s.phone_digit then 'phone'
      else 'fuzzy'
    end as match_kind
  from scored s
  where
    s.term = ''
    or s.name_substr
    or s.phone_substr
    or s.phone_digit
    or s.name_sim >= s.thr
  order by
    case when s.term = '' then 0 else s.name_sim end desc,
    s.name asc
  limit greatest(coalesce(p_limit, 20), 1);
$$;

grant execute on function public.search_landlords_fuzzy(text, int, real) to authenticated;
grant execute on function public.search_landlords_fuzzy(text, int, real) to service_role;