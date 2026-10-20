-- 2026-10-18 (doc 247, step 4): staff access-password functions had NO check on the caller and were executable by anon and authenticated.
--   set_staff_access_password(user, new_password): anyone could set any staff user's access password.
--   reset_staff_access_password(user, reset_by):   anyone could reset any staff user's password to the default 'WelileManager'
--                                                  and forge the audit row (p_reset_by was trusted).
--   verify_staff_access_password(user, password):  unlimited guesses, and for staff with no password row the default password is accepted.
-- This only gates the manager-portal UI (/manager-login sets local flags; real access is still the signed-in session + RLS), but it was an
-- integrity and audit hole. Fix:
--   set:    caller must be signed in with a staff role (not tenant/landlord/supporter/agent) and either set their own password, hold an admin
--           role, or target a first-login row (no password yet or must_change). Signed-out visitors can no longer call it.
--   reset:  caller must hold manager/super_admin/access_admin/ceo/coo/cfo/cto/admin/hr, and p_reset_by must be the caller (audit cannot be forged).
--   verify: stays callable signed-out (the portal may be used before sign-in) but locks a target after 5 wrong tries in 15 minutes.
-- The service role (edge functions, direct SQL without a JWT role) is unaffected.
-- NOT fixed here (product decision): staff without a password row still accept the default 'WelileManager' on first login.
create table if not exists public.staff_access_attempts (id bigserial primary key, user_id uuid not null, ok boolean not null, at timestamptz not null default now());
alter table public.staff_access_attempts enable row level security;
revoke all on public.staff_access_attempts from anon, authenticated;
create index if not exists staff_access_attempts_user_at on public.staff_access_attempts (user_id, at desc);

create or replace function public.set_staff_access_password(p_user_id uuid, p_new_password text)
 returns boolean language plpgsql security definer set search_path to 'public', 'extensions'
as $f$
declare
  v_uid uuid := auth.uid();
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_row public.staff_access_passwords%rowtype;
begin
  if not v_service then
    if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
    if not exists (select 1 from public.user_roles ur where ur.user_id = v_uid
                    and ur.role::text <> all (array['tenant','landlord','supporter','agent','senior_agent','sub_agent'])) then
      raise exception 'staff only' using errcode = '42501';
    end if;
    if v_uid <> p_user_id
       and not exists (select 1 from public.user_roles ur where ur.user_id = v_uid
                        and ur.role::text = any (array['manager','super_admin','access_admin','ceo','coo','cfo','cto','admin','hr'])) then
      select * into v_row from public.staff_access_passwords where user_id = p_user_id;
      if found and not v_row.must_change then
        raise exception 'not allowed to change another staff access password' using errcode = '42501';
      end if;
    end if;
  end if;
  insert into public.staff_access_passwords (user_id, password_hash, must_change)
  values (p_user_id, extensions.crypt(p_new_password, extensions.gen_salt('bf')), false)
  on conflict (user_id) do update set password_hash = excluded.password_hash, must_change = false, updated_at = now();
  return true;
end;
$f$;

create or replace function public.reset_staff_access_password(p_user_id uuid, p_reset_by uuid)
 returns boolean language plpgsql security definer set search_path to 'public'
as $f$
declare
  v_uid uuid := auth.uid();
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
begin
  if not v_service then
    if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
    if not exists (select 1 from public.user_roles ur where ur.user_id = v_uid
                    and ur.role::text = any (array['manager','super_admin','access_admin','ceo','coo','cfo','cto','admin','hr'])) then
      raise exception 'not allowed to reset staff access passwords' using errcode = '42501';
    end if;
    if p_reset_by is distinct from v_uid then
      raise exception 'p_reset_by must be the caller' using errcode = '42501';
    end if;
  end if;
  delete from public.staff_access_passwords where user_id = p_user_id;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (coalesce(p_reset_by, v_uid), 'staff_password_reset', 'staff_access_passwords', p_user_id::text,
          jsonb_build_object('target_user_id', p_user_id, 'reset_to', 'default', 'description', 'Manager login password reset to default'));
  return true;
end;
$f$;

create or replace function public.verify_staff_access_password(p_user_id uuid, p_password text)
 returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $f$
declare
  v_record public.staff_access_passwords%rowtype;
  v_result jsonb;
begin
  if (select count(*) from public.staff_access_attempts a where a.user_id = p_user_id and not a.ok and a.at > now() - interval '15 minutes') >= 5 then
    return jsonb_build_object('valid', false, 'must_change', false, 'locked', true);
  end if;
  select * into v_record from public.staff_access_passwords where user_id = p_user_id;
  if not found then
    if p_password = 'WelileManager' then
      insert into public.staff_access_passwords (user_id, password_hash, must_change)
      values (p_user_id, extensions.crypt('WelileManager', extensions.gen_salt('bf')), true)
      on conflict (user_id) do nothing;
      v_result := jsonb_build_object('valid', true, 'must_change', true);
    else
      v_result := jsonb_build_object('valid', false, 'must_change', false);
    end if;
  elsif v_record.password_hash = extensions.crypt(p_password, v_record.password_hash) then
    v_result := jsonb_build_object('valid', true, 'must_change', v_record.must_change);
  else
    v_result := jsonb_build_object('valid', false, 'must_change', false);
  end if;
  insert into public.staff_access_attempts (user_id, ok) values (p_user_id, (v_result ->> 'valid')::boolean);
  delete from public.staff_access_attempts where at < now() - interval '2 days';
  return v_result;
end;
$f$;

revoke execute on function public.set_staff_access_password(uuid, text) from public, anon;
revoke execute on function public.reset_staff_access_password(uuid, uuid) from public, anon;
grant execute on function public.set_staff_access_password(uuid, text) to authenticated, service_role;
grant execute on function public.reset_staff_access_password(uuid, uuid) to authenticated, service_role;

-- get_manager_profiles() (feeds the public /manager-login list) returned every manager's name, EMAIL, PHONE and photo to signed-out
-- visitors (security definer, executable by anon, no check). The portal only shows name and photo. Email and phone are now returned only
-- to signed-in staff (any role except tenant/landlord/supporter/agent) and the service role; everyone else gets them as null.
create or replace function public.get_manager_profiles()
 returns table(user_id uuid, full_name text, email text, phone text, avatar_url text)
 language sql stable security definer set search_path to 'public'
as $function$
  with me as (
    select (coalesce(auth.role(), 'service_role') = 'service_role'
            or exists (select 1 from public.user_roles x where x.user_id = auth.uid()
                        and x.role::text <> all (array['tenant','landlord','supporter','agent','senior_agent','sub_agent']))) as staff
  )
  select p.id as user_id,
         p.full_name,
         case when (select staff from me) then p.email end as email,
         case when (select staff from me) then p.phone end as phone,
         p.avatar_url
    from public.profiles p
   inner join public.user_roles ur on ur.user_id = p.id
   where ur.role = 'manager'
     and (ur.enabled is null or ur.enabled = true)
   order by p.full_name;
$function$;
