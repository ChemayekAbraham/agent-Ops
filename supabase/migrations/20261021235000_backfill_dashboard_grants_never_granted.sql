-- Backfill dashboard grants that were never made (2026-10-21).
--
-- 20261021180000 made staff dashboards need role AND an active staff_permissions
-- grant, but existing staff were never granted the dashboards for the roles they
-- already held: 33 of 36 staff were missing 65 grants and got "404" on their own
-- dashboards (159 denials, 12 people, by the guard telemetry).
--
-- At the user's instruction this restores only the 44 that were NEVER granted
-- (no staff_permissions row at all for that person and dashboard). The 21 that
-- were revoked in July-September stay revoked for HR to decide, even though those
-- revocations had no effect back then (a role alone was enough).
--
-- Role -> dashboard mapping is ROLE_DASHBOARD_KEY (src/hooks/useStaffPermissions.ts).
-- super_admin and cto are skipped: they bypass the allowlist. Each grant gets the
-- same audit_logs row grant_dashboard_access writes, marked as a system backfill.

DO $$
DECLARE
  v_rows integer;
BEGIN
  SET LOCAL lock_timeout = '5s';

  WITH m(role, dash) AS (
    VALUES ('ceo','ceo'), ('coo','coo'), ('cfo','cfo'), ('cmo','cmo'), ('crm','crm'), ('hr','hr'), ('rd','rd'),
           ('manager','company-ops'), ('operations','company-ops'), ('financial_ops','financial-ops'),
           ('agent_ops','agent-ops'), ('tenant_ops','tenant-ops'), ('landlord_ops','landlord-ops'),
           ('partner_ops','partner-ops')
  ),
  need AS (
    SELECT DISTINCT r.user_id, m.dash
      FROM public.user_roles r
      JOIN m ON m.role = r.role::text
      JOIN auth.users au ON au.id = r.user_id
     WHERE NOT EXISTS (SELECT 1 FROM public.user_roles b
                        WHERE b.user_id = r.user_id AND b.role::text IN ('super_admin', 'cto'))
       -- never granted: no row at all, active or revoked
       AND NOT EXISTS (SELECT 1 FROM public.staff_permissions sp
                        WHERE sp.user_id = r.user_id AND sp.permitted_dashboard = m.dash)
  ),
  ins AS (
    INSERT INTO public.staff_permissions (user_id, permitted_dashboard, granted_by, granted_at)
    SELECT user_id, dash, NULL, now() FROM need
    RETURNING id, user_id, permitted_dashboard
  )
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, new_values)
  SELECT NULL, 'dashboard_access_granted', 'staff_permissions', ins.id::text,
         format('Granted %s dashboard access', ins.permitted_dashboard),
         'System backfill: role held when the dashboard allowlist went live (20261021180000) but never granted',
         jsonb_build_object('user_id', ins.user_id, 'dashboard', ins.permitted_dashboard, 'backfill', true)
    FROM ins;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'dashboard grant backfill: % grants', v_rows;
END
$$;
