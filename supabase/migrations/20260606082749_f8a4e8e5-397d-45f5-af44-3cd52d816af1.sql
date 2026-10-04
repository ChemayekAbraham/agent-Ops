create extension if not exists pg_trgm with schema public;

create index if not exists idx_landlords_name_trgm
  on public.landlords using gin (name gin_trgm_ops);
create index if not exists idx_landlords_phone_trgm
  on public.landlords using gin (phone gin_trgm_ops);

create or replace function public.search_landlords_fuzzy(
  p_query text default '',
  p_limit int default 20
)
returns setof public.landlords
language sql
stable
security definer
set search_path = public
as $$
  with q as (
    select
      coalesce(nullif(trim(p_query), ''), '') as term,
      regexp_replace(coalesce(p_query, ''), '\D', '', 'g') as digits
  )
  select l.*
  from public.landlords l, q
  where
    q.term = ''
    or l.name ilike '%' || q.term || '%'
    or l.phone ilike '%' || q.term || '%'
    or (length(q.digits) >= 3 and l.phone ilike '%' || q.digits || '%')
    or similarity(l.name, q.term) > 0.2
    or word_similarity(q.term, l.name) > 0.3
  order by
    case
      when q.term = '' then 0
      else greatest(similarity(l.name, q.term), word_similarity(q.term, l.name))
    end desc,
    l.name asc
  limit greatest(coalesce(p_limit, 20), 1);
$$;

grant execute on function public.search_landlords_fuzzy(text, int) to authenticated;
grant execute on function public.search_landlords_fuzzy(text, int) to service_role;