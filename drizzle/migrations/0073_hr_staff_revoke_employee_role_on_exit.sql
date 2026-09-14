update public.user_roles
   set enabled = false,
       disable_reason = 'Staff exited — employee role revoked 2026-09-14 to match hr_staff'
 where role = 'employee'
   and enabled
   and user_id in (select user_id from public.hr_staff where not active);

create or replace function public.hr_staff_revoke_employee_role_on_exit()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if old.active and not new.active then
    update public.user_roles
       set enabled = false,
           disable_reason = 'Staff exited '
                            || coalesce(new.ended_on::text, current_date::text)
                            || ' — employee role revoked automatically'
     where user_id = new.user_id
       and role = 'employee'
       and enabled;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_hr_staff_revoke_employee_role_on_exit on public.hr_staff;
create trigger trg_hr_staff_revoke_employee_role_on_exit
  after update on public.hr_staff
  for each row execute function public.hr_staff_revoke_employee_role_on_exit();