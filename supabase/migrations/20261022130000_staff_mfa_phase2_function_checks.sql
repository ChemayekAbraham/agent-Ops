-- 2026-10-22 (doc 249, docs/security/mfa-enforcement-design.md): staff MFA, phase 2a. Applied to production 2026-10-22 with mode 'shadow' (no effect until the mode is changed).
--
-- The restrictive table policies (phase 0) do not cover SECURITY DEFINER functions, which read and write tables as their owner. So the functions a signed-in user can call that
-- WRITE money, ledger, withdrawal, role or profile tables get an explicit check as their first statement: PERFORM public.require_staff_aal2().
-- require_staff_aal2() raises 42501 'mfa_required' only for a staff member whose session is not at the authenticator level, and only when staff_mfa_config.mode requires it.
-- Non-staff users, the service role and cron (no auth.uid()) always pass. 56 functions were edited (list in docs/security/mfa-enforcement-design.md).
-- The generator is idempotent (skips functions already edited) and skips any function it cannot edit, reporting it as a warning. Re-run after adding functions that write those tables.
-- Not yet covered: read-only money RPCs (for example get_receivables_total) and the 265 functions that check a staff role: next list.

create or replace function public.require_staff_aal2() returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.staff_mfa_ok() then
    raise exception 'mfa_required: verify with your authenticator app to continue' using errcode = '42501';
  end if;
end $$;
revoke all on function public.require_staff_aal2() from public, anon;
grant execute on function public.require_staff_aal2() to authenticated, service_role;

-- One call for the app: is the second step required, offered, or not needed for me? Works at the password-only level (no table reads by the caller).
create or replace function public.my_staff_mfa_status() returns jsonb language sql stable security definer set search_path = public as $$
  with me as (
    select auth.uid() as uid,
      (select c.mode from public.staff_mfa_config c where c.id) as mode,
      exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.enabled and ur.role::text in ('manager','super_admin','coo','ceo','cto','cfo','cmo','crm','hr','rd','operations','employee','tenant_ops','agent_ops','landlord_ops','partner_ops','financial_ops','access_admin','admin')) as is_staff,
      exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.enabled and ur.role::text in ('super_admin','ceo','cto','cfo','coo','access_admin','admin')) as is_admin,
      exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status::text = 'verified' and f.factor_type::text = 'totp') as enrolled
  )
  select jsonb_build_object(
    'mode', coalesce(mode, 'off'), 'is_staff', is_staff, 'is_admin', is_admin, 'enrolled', enrolled,
    'required', (mode = 'all' and is_staff) or (mode = 'admin' and is_admin),
    'prompt', (mode in ('shadow','admin','all') and is_staff and not enrolled))
  from me where uid is not null
$$;
revoke all on function public.my_staff_mfa_status() from public, anon;
grant execute on function public.my_staff_mfa_status() to authenticated, service_role;

do $do$
declare r record; d text; head text; body text; fails text := '';
begin
  set local lock_timeout = '5s';
  for r in select p.oid, p.proname from pg_proc p join pg_language l on l.oid = p.prolang
           where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.prokind = 'f' and l.lanname = 'plpgsql'
             and has_function_privilege('authenticated', p.oid, 'execute')
             and p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?(general_ledger|wallets_physical|wallet_balances_projection|withdrawal_requests|pending_wallet_operations|user_roles|staff_permissions|profiles)'
             and p.prosrc !~ 'require_staff_aal2' and p.proname not in ('require_staff_aal2','staff_mfa_ok','set_staff_mfa_mode') loop
    begin
      d := pg_get_functiondef(r.oid);
      head := substr(d, 1, position('$function$' in d) + 9);
      body := substr(d, position('$function$' in d) + 10);
      if body !~* '\mbegin\M' then raise exception 'no begin'; end if;
      body := regexp_replace(body, '\mbegin\M', E'BEGIN\n  PERFORM public.require_staff_aal2();', 'i');
      execute head || body;
    exception when others then fails := fails || r.proname || '(' || left(sqlerrm, 30) || ') ';
    end;
  end loop;
  if fails <> '' then raise warning 'FAILED: %', fails; end if;
end $do$;
