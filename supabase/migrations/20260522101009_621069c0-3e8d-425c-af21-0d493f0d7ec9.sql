create or replace function public.list_assignable_agents()
returns table (id uuid, full_name text, phone text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.full_name, p.phone
  from public.user_roles ur
  join public.profiles p on p.id = ur.user_id
  where ur.role = 'agent'
    and coalesce(ur.enabled, true) = true
  order by coalesce(p.full_name, '') asc;
$$;

revoke all on function public.list_assignable_agents() from public;
grant execute on function public.list_assignable_agents() to authenticated;