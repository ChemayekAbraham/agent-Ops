-- Let internal staff read the 360-day pricing flag so dashboards can show
-- the live ON/OFF badge. CFO, COO and super admin already could.
-- This does not update new_plans_enabled (it stays at its current value,
-- inserted as false) and does not grant insert, update or delete.

drop policy if exists "v360_settings_read" on public.v360_settings;
create policy v360_settings_read on public.v360_settings
  for select to authenticated
  using (
    (select has_role((select auth.uid()), 'ceo'::app_role))
    or (select has_role((select auth.uid()), 'coo'::app_role))
    or (select has_role((select auth.uid()), 'cfo'::app_role))
    or (select has_role((select auth.uid()), 'cto'::app_role))
    or (select has_role((select auth.uid()), 'cmo'::app_role))
    or (select has_role((select auth.uid()), 'crm'::app_role))
    or (select has_role((select auth.uid()), 'hr'::app_role))
    or (select has_role((select auth.uid()), 'rd'::app_role))
    or (select has_role((select auth.uid()), 'manager'::app_role))
    or (select has_role((select auth.uid()), 'employee'::app_role))
    or (select has_role((select auth.uid()), 'operations'::app_role))
    or (select has_role((select auth.uid()), 'super_admin'::app_role))
    or (select has_role((select auth.uid()), 'admin'::app_role))
    or (select has_role((select auth.uid()), 'access_admin'::app_role))
    or (select has_role((select auth.uid()), 'tenant_ops'::app_role))
    or (select has_role((select auth.uid()), 'landlord_ops'::app_role))
    or (select has_role((select auth.uid()), 'agent_ops'::app_role))
    or (select has_role((select auth.uid()), 'financial_ops'::app_role))
    or (select has_role((select auth.uid()), 'partner_ops'::app_role))
  );
