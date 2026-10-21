-- 2026-10-18 (doc 247, step 16): v_agent_landlord_float_reconciliation (per-agent name, phone, cached vs correct landlord-float balance; 825 rows)
-- was an owner-rights view selectable by any signed-in user. Only reader: LandlordFloatReconciliationPanel (not mounted on any page today); no DB dependents.
-- Gate: service role, is_financial_ops_staff, or an enabled cfo / ceo / coo / cto / financial_ops / manager / super_admin role.
-- Already applied to production 2026-10-18.
create or replace function public.can_view_finance_reports(_uid uuid)
 returns boolean language sql stable security definer set search_path to 'public'
as $f$
  select coalesce(auth.role(), 'service_role') = 'service_role'
      or (_uid is not null and (
           public.is_financial_ops_staff(_uid)
           or exists (select 1 from public.user_roles ur where ur.user_id = _uid and ur.enabled = true
                        and ur.role in ('cfo','ceo','coo','cto','financial_ops','manager','super_admin'))));
$f$;
revoke all on function public.can_view_finance_reports(uuid) from public, anon;
grant execute on function public.can_view_finance_reports(uuid) to authenticated, service_role;

do $$
declare d text;
begin
  d := regexp_replace(pg_get_viewdef('public.v_agent_landlord_float_reconciliation'::regclass), ';\s*$', '');
  execute 'create or replace view public.v_agent_landlord_float_reconciliation as select * from (' || d || ') q where public.can_view_finance_reports(auth.uid())';
end $$;
