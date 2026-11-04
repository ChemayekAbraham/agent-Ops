-- 2026-10-22 (doc 249): Information and Security Policy section 5: "Access rights are reviewed at least quarterly" and revoked on the final working day.
-- Read-only report of every enabled staff account: roles, staff permission, emailed-code 2FA status, last sign-in, password-change record, flags
-- (admin_role, no_email_2fa, never_signed_in / inactive_90d, no_recorded_password_change). Callable only by super_admin / ceo / cto / access_admin or the service role.
-- Run each quarter and after every HR leaver notice; the output is the evidence for the review. Applied to production 2026-10-22.
create or replace function public.staff_access_review()
returns table (user_id uuid, full_name text, roles text[], has_staff_permission boolean, email_2fa_enabled boolean, last_sign_in_at timestamptz, days_since_sign_in integer, password_change_recorded boolean, flags text[])
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), 'service_role') <> 'service_role'
     and not exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.enabled and ur.role::text in ('super_admin','ceo','cto','access_admin')) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
  with staff as (
    select ur.user_id as uid, array_agg(distinct ur.role::text order by ur.role::text) as rls
    from public.user_roles ur
    where ur.enabled and ur.role::text in ('manager','super_admin','coo','ceo','cto','cfo','cmo','crm','hr','rd','operations','employee','tenant_ops','agent_ops','landlord_ops','partner_ops','financial_ops','access_admin')
    group by ur.user_id
  ), x as (
    select s.uid, p.full_name as nm, s.rls,
           exists (select 1 from public.staff_permissions sp where sp.user_id = s.uid and sp.revoked_at is null) as perm,
           coalesce((select t.enabled from public.user_two_factor t where t.user_id = s.uid), false) as tfa,
           u.last_sign_in_at as lsi,
           exists (select 1 from public.password_change_audit pc where pc.user_id = s.uid) as pwc
    from staff s
    left join public.profiles p on p.id = s.uid
    left join auth.users u on u.id = s.uid
  )
  select x.uid, x.nm, x.rls, x.perm, x.tfa, x.lsi,
         case when x.lsi is null then null else extract(day from now() - x.lsi)::int end,
         x.pwc,
         array_remove(array[
           case when x.rls && array['super_admin','ceo','cto','cfo','coo','access_admin'] then 'admin_role' end,
           case when not x.tfa then 'no_email_2fa' end,
           case when x.lsi is null then 'never_signed_in' when x.lsi < now() - interval '90 days' then 'inactive_90d' end,
           case when not x.pwc then 'no_recorded_password_change' end
         ], null)
  from x
  order by (x.rls && array['super_admin','ceo','cto','cfo','coo','access_admin']) desc, x.nm;
end;
$$;
revoke all on function public.staff_access_review() from public, anon;
grant execute on function public.staff_access_review() to authenticated, service_role;
