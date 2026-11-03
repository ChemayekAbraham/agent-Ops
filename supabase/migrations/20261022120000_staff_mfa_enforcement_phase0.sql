-- 2026-10-22 (doc 249, docs/security/mfa-enforcement-design.md): staff MFA enforcement, PHASE 0 (report-only; nothing is blocked).
-- Applied to production 2026-10-22 with mode 'shadow'. Enforcement is switched on later with public.set_staff_mfa_mode(), which refuses while anyone in scope has no verified authenticator.
--
-- Design note (measured): the check must NOT live in has_role(). The staff policies call has_role() once per row, and putting the gate there made a 3,700-row read about 14x slower
-- (76 ms to 1,103 ms), even with a lightweight gate. Instead a RESTRICTIVE policy per table calls staff_mfa_ok() as an uncorrelated sub-select, which Postgres evaluates once per
-- query: same read measured 100 ms before and 69 ms after (noise). With mode 'all', an aal1 manager sees 0 audit rows and the same manager at aal2 sees all of them.
--
-- Modes (public.staff_mfa_config.mode): off | shadow | admin | all.  shadow = no effect.  admin = the admin roles must be aal2.  all = every staff role must be aal2.
-- Staff = roles manager, super_admin, coo, ceo, cto, cfo, cmo, crm, hr, rd, operations, employee, tenant_ops, agent_ops, landlord_ops, partner_ops, financial_ops, access_admin, admin.
-- Service role, cron, edge functions using the service key and non-staff users are unaffected.
-- Kill switch: select public.set_staff_mfa_mode('off', 'reason of at least ten characters'), or as the database owner: update public.staff_mfa_config set mode = 'off' where id;
-- Phase 2 still to build: gate in money/admin edge functions (requireStaffAal2) and in SECURITY DEFINER RPCs that read tables as owner (they bypass these policies).

create table if not exists public.staff_mfa_config (
  id boolean primary key default true check (id),
  mode text not null default 'shadow' check (mode in ('off','shadow','admin','all')),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.staff_mfa_config enable row level security;
revoke all on table public.staff_mfa_config from anon, authenticated;
grant select on table public.staff_mfa_config to authenticated;
create policy staff_mfa_config_read on public.staff_mfa_config for select to authenticated using (true);
insert into public.staff_mfa_config (id, mode) values (true, 'shadow') on conflict (id) do nothing;

create or replace function public.staff_mfa_ok() returns boolean language sql stable security definer set search_path = public as $f$
  select case (select c.mode from public.staff_mfa_config c where c.id)
    when 'all' then coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' or not exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.enabled and ur.role::text in ('manager','super_admin','coo','ceo','cto','cfo','cmo','crm','hr','rd','operations','employee','tenant_ops','agent_ops','landlord_ops','partner_ops','financial_ops','access_admin','admin'))
    when 'admin' then coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' or not exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.enabled and ur.role::text in ('super_admin','ceo','cto','cfo','coo','access_admin','admin'))
    else true end $f$;
revoke all on function public.staff_mfa_ok() from public, anon;
grant execute on function public.staff_mfa_ok() to authenticated, service_role;

-- One restrictive policy on every public table (926 at the time of writing). Re-run safe: skips tables that already have it.
do $do$
declare r record;
begin
  set local lock_timeout = '8s';
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r','p') and c.relrowsecurity
             and c.relname not in ('staff_mfa_config')
             and not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'mfa_required_for_staff') loop
    execute format('create policy mfa_required_for_staff on public.%I as restrictive for all to authenticated using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()))', r.relname);
  end loop;
end $do$;
-- A new table needs the same policy (see CLAUDE.md "new tables need explicit grants"): create policy mfa_required_for_staff on public.<t> as restrictive for all to authenticated using ((select public.staff_mfa_ok())) with check ((select public.staff_mfa_ok()));

-- Readiness report: who is enrolled, who has live password-only sessions (they would be asked to verify).
create or replace function public.staff_mfa_readiness()
returns table (user_id uuid, full_name text, roles text[], is_admin boolean, totp_enrolled boolean, active_sessions integer, aal1_sessions integer, aal2_sessions integer, last_sign_in_at timestamptz, flags text[])
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(auth.role(), 'service_role') <> 'service_role'
     and not exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.enabled and ur.role::text in ('super_admin','ceo','cto','access_admin')) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return query
  with staff as (
    select r.user_id as uid, array_agg(distinct r.role::text order by r.role::text) as rls
    from public.user_roles r
    where r.enabled and r.role::text in ('manager','super_admin','coo','ceo','cto','cfo','cmo','crm','hr','rd','operations','employee','tenant_ops','agent_ops','landlord_ops','partner_ops','financial_ops','access_admin','admin')
    group by r.user_id
  ), x as (
    select s.uid, p.full_name as nm, s.rls,
      (s.rls && array['super_admin','ceo','cto','cfo','coo','access_admin','admin']) as adm,
      exists (select 1 from auth.mfa_factors f where f.user_id = s.uid and f.status::text = 'verified' and f.factor_type::text = 'totp') as tot,
      (select count(*)::int from auth.sessions a where a.user_id = s.uid and (a.not_after is null or a.not_after > now()) and coalesce(a.refreshed_at::timestamptz, a.updated_at, a.created_at) > now() - interval '14 days') as act,
      (select count(*)::int from auth.sessions a where a.user_id = s.uid and a.aal::text = 'aal1' and (a.not_after is null or a.not_after > now()) and coalesce(a.refreshed_at::timestamptz, a.updated_at, a.created_at) > now() - interval '14 days') as a1,
      (select count(*)::int from auth.sessions a where a.user_id = s.uid and a.aal::text = 'aal2' and (a.not_after is null or a.not_after > now()) and coalesce(a.refreshed_at::timestamptz, a.updated_at, a.created_at) > now() - interval '14 days') as a2,
      u.last_sign_in_at as lsi
    from staff s left join public.profiles p on p.id = s.uid left join auth.users u on u.id = s.uid
  )
  select x.uid, x.nm, x.rls, x.adm, x.tot, x.act, x.a1, x.a2, x.lsi,
    array_remove(array[case when not x.tot then 'needs_enrolment' end, case when x.a1 > 0 then 'active_aal1_session' end, case when x.lsi is null then 'never_signed_in' end], null)
  from x order by x.adm desc, x.tot, x.nm;
end $$;
revoke all on function public.staff_mfa_readiness() from public, anon;
grant execute on function public.staff_mfa_readiness() to authenticated, service_role;

-- Guarded mode switch: super_admin (or the database owner); reason of 10+ characters; refuses admin/all while anyone in scope has no verified authenticator; audited.
create or replace function public.set_staff_mfa_mode(p_mode text, p_reason text)
returns text
language plpgsql security definer set search_path = public as $$
declare v_old text; v_missing int;
begin
  if coalesce(auth.role(), 'service_role') <> 'service_role'
     and not exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.enabled and ur.role::text = 'super_admin') then
    raise exception 'only a super_admin may change the staff MFA mode' using errcode = '42501';
  end if;
  if p_mode not in ('off','shadow','admin','all') then raise exception 'mode must be off, shadow, admin or all'; end if;
  if p_reason is null or length(trim(p_reason)) < 10 then raise exception 'a reason of at least 10 characters is required'; end if;
  if p_mode in ('admin','all') then
    select count(*) into v_missing
    from (select distinct r.user_id from public.user_roles r
          where r.enabled and r.role::text in (case when p_mode = 'admin' then 'super_admin' else 'manager' end, 'ceo','cto','cfo','coo','access_admin','admin')
             or (p_mode = 'all' and r.role::text in ('manager','super_admin','coo','ceo','cto','cfo','cmo','crm','hr','rd','operations','employee','tenant_ops','agent_ops','landlord_ops','partner_ops','financial_ops','access_admin','admin') and r.enabled)) s
    where not exists (select 1 from auth.mfa_factors f where f.user_id = s.user_id and f.status::text = 'verified' and f.factor_type::text = 'totp');
    if v_missing > 0 then
      raise exception '% account(s) in scope have no verified authenticator; refusing to enforce (see staff_mfa_readiness())', v_missing;
    end if;
  end if;
  select mode into v_old from public.staff_mfa_config where id;
  update public.staff_mfa_config set mode = p_mode, updated_at = now(), updated_by = auth.uid() where id;
  insert into public.audit_logs (user_id, action_type, action, table_name, record_id, old_values, new_values, reason)
  values (auth.uid(), 'security_setting_change', 'Changed staff MFA mode', 'staff_mfa_config', 'mode', jsonb_build_object('mode', v_old), jsonb_build_object('mode', p_mode), p_reason);
  return v_old || ' -> ' || p_mode;
end $$;
revoke all on function public.set_staff_mfa_mode(text, text) from public, anon;
grant execute on function public.set_staff_mfa_mode(text, text) to authenticated, service_role;

-- Cleanup of a first attempt (the heavy gate function and an unused settings table were created and left inert during testing).
drop function if exists public.staff_mfa_gate(uuid, public.app_role);
drop table if exists public.security_settings;
