create or replace function public.resolve_owned_notification_email(p_user_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_auth_email text;
  v_profile_email text;
  v_shared int;
begin
  if p_user_id is null then
    return null;
  end if;

  select lower(trim(email)) into v_auth_email from auth.users where id = p_user_id;
  select lower(trim(email)) into v_profile_email from public.profiles where id = p_user_id;

  -- Placeholder / internal login addresses are never deliverable mailboxes.
  if v_auth_email is not null
     and v_auth_email <> ''
     and v_auth_email !~* '@([a-z0-9-]+\.)*welile\.(user|agent)$'
     and v_auth_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return v_auth_email;
  end if;

  if v_profile_email is null
     or v_profile_email = ''
     or v_profile_email ~* '@([a-z0-9-]+\.)*welile\.(user|agent)$'
     or v_profile_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return null;
  end if;

  -- The profile address must belong to this user alone. If any other profile
  -- or any other auth account uses it, it is somebody else's mailbox.
  select count(*) into v_shared
  from public.profiles p
  where lower(trim(p.email)) = v_profile_email
    and p.id <> p_user_id;

  if v_shared > 0 then
    return null;
  end if;

  select count(*) into v_shared
  from auth.users u
  where lower(trim(u.email)) = v_profile_email
    and u.id <> p_user_id;

  if v_shared > 0 then
    return null;
  end if;

  return v_profile_email;
end;
$$;

revoke all on function public.resolve_owned_notification_email(uuid) from public, anon, authenticated;
grant execute on function public.resolve_owned_notification_email(uuid) to service_role;