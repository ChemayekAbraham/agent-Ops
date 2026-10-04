insert into public.user_roles (user_id, role, enabled)
values ('a9258d45-3e27-4827-af71-64344e76fb4f', 'employee', true)
on conflict (user_id, role) do update set enabled = true;

create or replace function public.hr_unenrolled_staff_candidates(_q text default '')
returns table(user_id uuid, display_name text, staff_roles text)
language sql stable security definer set search_path to 'public' as $$
  select u.id,
         coalesce(u.raw_user_meta_data->>'full_name',
                  u.raw_user_meta_data->>'name',
                  u.email::text) as display_name,
         string_agg(distinct ur.role::text, ', ' order by ur.role::text) as staff_roles
  from auth.users u
  join public.user_roles ur
    on ur.user_id = u.id
   and ur.enabled = true
   and ur.role::text not in ('tenant','agent','landlord','supporter','senior_agent','sub_agent')
  where public.hr_is_admin()
    and exists (select 1 from public.user_roles e
                 where e.user_id = u.id and e.role = 'employee' and e.enabled)
    and not exists (select 1 from public.hr_staff s where s.user_id = u.id)
    and (coalesce(_q,'') = ''
         or coalesce(u.raw_user_meta_data->>'full_name','') ilike '%' || _q || '%'
         or coalesce(u.raw_user_meta_data->>'name','') ilike '%' || _q || '%'
         or u.email ilike '%' || _q || '%')
  group by u.id, u.email, u.raw_user_meta_data
  order by 2
  limit 50;
$$;

create or replace function public.hr_staff_require_employee_role()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_check boolean := false;
begin
  if tg_op = 'INSERT' then
    v_check := new.active;
  elsif tg_op = 'UPDATE' then
    v_check := new.active
               and (not old.active or new.user_id is distinct from old.user_id);
  end if;

  if v_check and not exists (
    select 1 from public.user_roles ur
     where ur.user_id = new.user_id
       and ur.role = 'employee'
       and ur.enabled
  ) then
    raise exception 'This person cannot be staff: the employee platform role is not active on their account. An access administrator must activate the employee role first, then enrol or reinstate them.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_hr_staff_require_employee_role on public.hr_staff;
create trigger trg_hr_staff_require_employee_role
  before insert or update on public.hr_staff
  for each row execute function public.hr_staff_require_employee_role();