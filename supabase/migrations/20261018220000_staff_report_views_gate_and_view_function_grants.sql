-- 2026-10-18 (doc 247, step 17): four staff-read owner-rights views gated, and a regression from the function lockdown repaired.
--
-- 1) REGRESSION: Postgres checks a function's EXECUTE privilege against the CALLING role even inside an owner-rights view.
--    The part-1 lockdown (migration 20261017140000) closed pure helper functions that views call, so selecting their columns as a
--    signed-in user failed with "permission denied for function ...": ug_norm_name (v_tenant_location_pivot, vw_agent_ops_directory)
--    and continent_for_country (v_tenant_ops_tenant_base). Both are immutable text normalisers that read no tables; EXECUTE restored to authenticated.
--    (count(*) hides the failure because it skips unused columns; test with select * / row::text.)
--    NOT restored: merchant_float_position_at (SECURITY DEFINER, reads any user's float ledger; used by v_merchant_oop_evidence) - handled with that view.
--
-- 2) can_view_staff_reports(uid): service role, an enabled staff role (manager, super_admin, coo, ceo, cto, cfo, cmo, crm, hr, rd, operations,
--    employee, tenant_ops, agent_ops, landlord_ops, partner_ops, financial_ops, access_admin) or any active staff_permissions row.
--    Broad on purpose: owner-rights functions that read these views (cc_*, get_tenants_at_leaf, get_tenant_location_breakdown, ...) evaluate it with the CALLER's
--    auth.uid(). Every caller found is a staff screen (TenantLocationBrowser, calling hub, AgentFeatureFlagsPanel, usePlaceInfo, useTenantCallReports).
--    Side effect: get_tenants_at_leaf / get_tenant_location_breakdown, which had no role check of their own, now return nothing for non-staff.
--    Gated: v_tenant_call_summary, v_tenant_location_pivot, vw_agent_ops_directory, v_tenant_ops_tenant_base.
--
-- Already applied to production 2026-10-18.
grant execute on function public.ug_norm_name(text) to authenticated;
grant execute on function public.continent_for_country(text) to authenticated;

create or replace function public.can_view_staff_reports(_uid uuid)
 returns boolean language sql stable security definer set search_path to 'public'
as $f$
  select coalesce(auth.role(), 'service_role') = 'service_role'
      or (_uid is not null and (
           exists (select 1 from public.user_roles ur where ur.user_id = _uid and ur.enabled = true
                     and ur.role in ('manager','super_admin','coo','ceo','cto','cfo','cmo','crm','hr','rd','operations','employee',
                                     'tenant_ops','agent_ops','landlord_ops','partner_ops','financial_ops','access_admin'))
           or exists (select 1 from public.staff_permissions sp where sp.user_id = _uid and sp.revoked_at is null)));
$f$;
revoke all on function public.can_view_staff_reports(uuid) from public, anon;
grant execute on function public.can_view_staff_reports(uuid) to authenticated, service_role;

do $$
declare d text; v text;
begin
  foreach v in array array['v_tenant_call_summary','v_tenant_location_pivot','vw_agent_ops_directory','v_tenant_ops_tenant_base'] loop
    d := regexp_replace(pg_get_viewdef(('public.'||v)::regclass), ';\s*$', '');
    execute format('create or replace view public.%I as select * from (%s) q where public.can_view_staff_reports(auth.uid())', v, d);
  end loop;
end $$;
