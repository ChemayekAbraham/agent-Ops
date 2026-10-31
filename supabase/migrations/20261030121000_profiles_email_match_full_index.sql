-- The partial index from 20261030120000 (`where email is not null`) was never chosen
-- by the planner, so oauth_signup_duplicate_of scanned all of profiles (~2s per
-- Google/Apple signup). The same expression without the predicate is used.
--
-- The function's generic plan also preferred walking profiles by created_at for the
-- LIMIT 1, which reads every row when there is no match. The materialized CTE makes
-- it fetch the few rows with that email through the index first.

drop index if exists public.profiles_email_match_idx;

create index if not exists profiles_email_match_idx
  on public.profiles (public.normalize_email_for_match(email));

create or replace function public.oauth_signup_duplicate_of(p_email text, p_new_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  with same_email as materialized (
    select p.id, p.created_at, p.deleted_at
    from public.profiles p
    where public.normalize_email_for_match(p.email) = public.normalize_email_for_match(p_email)
  )
  select s.id
  from same_email s
  join auth.users au on au.id = s.id
  where s.id <> p_new_id
    and s.deleted_at is null
    and coalesce(au.email, '') not ilike '%@deleted.invalid'
    and not exists (
      select 1 from public.deleted_accounts d
      where d.user_id = s.id and d.status <> 'restored'
    )
  order by s.created_at
  limit 1;
$$;
