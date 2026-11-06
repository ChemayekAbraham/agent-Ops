-- Staff MFA: a database date after which a staff member without an authenticator app MUST enrol (doc 264).
--
-- Today (mode 'shadow') staff without an authenticator only see an optional banner. Josh (CTO), 2026-11-06: start with
-- his account and Pius, and after 10 days make every staff user enrol. This adds ONE date, force_enrol_from. From that
-- moment my_staff_mfa_status() answers force_enrol = true for a staff member who has no verified authenticator, and the
-- app shows the existing full-screen enrol step (no skip, only "Sign out"). Nothing is blocked in the database by this:
-- the mode stays 'shadow', so data reads are unchanged; the step only gates the screens.
--
-- The date lives here, not in the app, so it can be moved or switched off without a deploy (the lesson of 2026-10-17):
--   select public.set_staff_mfa_force_enrol(null, 'reason of at least ten characters');   -- off
--   select public.set_staff_mfa_force_enrol('2026-11-15 21:00:00+00', '...');             -- 16 Nov 00:00 East Africa Time
-- Mode 'off' also switches the forced step off (the existing kill switch). Only a super_admin (or the owner) may set it.

set local lock_timeout = '5s';

alter table public.staff_mfa_config add column if not exists force_enrol_from timestamptz;

-- Same body as the live function (read from production 2026-11-06) plus force_enrol / force_enrol_from.
create or replace function public.my_staff_mfa_status()
returns jsonb
language sql
stable security definer
set search_path to 'public'
as $function$
  with me as (
    select auth.uid() as uid,
      (select c.mode from public.staff_mfa_config c where c.id) as mode,
      (select c.force_enrol_from from public.staff_mfa_config c where c.id) as force_from,
      exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.enabled and ur.role::text in ('manager','super_admin','coo','ceo','cto','cfo','cmo','crm','hr','rd','operations','employee','tenant_ops','agent_ops','landlord_ops','partner_ops','financial_ops','access_admin','admin')) as is_staff,
      exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.enabled and ur.role::text in ('super_admin','ceo','cto','cfo','coo','access_admin','admin')) as is_admin,
      exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status::text = 'verified' and f.factor_type::text = 'totp') as enrolled
  )
  select jsonb_build_object(
    'mode', coalesce(mode, 'off'), 'is_staff', is_staff, 'is_admin', is_admin, 'enrolled', enrolled,
    'required', (mode = 'all' and is_staff) or (mode = 'admin' and is_admin),
    'prompt', (mode in ('shadow','admin','all') and is_staff and not enrolled),
    'force_enrol', (mode in ('shadow','admin','all') and is_staff and not enrolled and force_from is not null and now() >= force_from),
    'force_enrol_from', force_from)
  from me where uid is not null
$function$;

-- Guarded setter: super_admin or the database owner; a reason of 10+ characters; audited. NULL switches the forced step off.
create or replace function public.set_staff_mfa_force_enrol(p_from timestamptz, p_reason text)
returns text
language plpgsql security definer set search_path = public as $$
declare v_old timestamptz;
begin
  if coalesce(auth.role(), 'service_role') <> 'service_role'
     and not exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.enabled and ur.role::text = 'super_admin') then
    raise exception 'only a super_admin may change the staff MFA enrol date' using errcode = '42501';
  end if;
  if p_reason is null or length(trim(p_reason)) < 10 then raise exception 'a reason of at least 10 characters is required'; end if;
  select force_enrol_from into v_old from public.staff_mfa_config where id;
  update public.staff_mfa_config set force_enrol_from = p_from, updated_at = now(), updated_by = auth.uid() where id;
  insert into public.audit_logs (user_id, action_type, action, table_name, record_id, old_values, new_values, reason)
  values (auth.uid(), 'security_setting_change', 'Changed staff MFA forced-enrol date', 'staff_mfa_config', 'force_enrol_from',
          jsonb_build_object('force_enrol_from', v_old), jsonb_build_object('force_enrol_from', p_from), p_reason);
  return coalesce(v_old::text, 'off') || ' -> ' || coalesce(p_from::text, 'off');
end $$;
revoke all on function public.set_staff_mfa_force_enrol(timestamptz, text) from public, anon;
grant execute on function public.set_staff_mfa_force_enrol(timestamptz, text) to authenticated, service_role;
-- CREATE OR REPLACE kept the grants of my_staff_mfa_status.
