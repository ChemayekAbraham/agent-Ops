-- Dashboard allowlist: only super_admin, cto and hr may grant or revoke, and
-- only through these SECURITY DEFINER functions. Retire the access_admin role.
--
-- Rule (enforced in the app by RoleGuard/useStaffPermissions): a staff member
-- opens a staff dashboard only if they hold an allowed role AND have an active
-- staff_permissions row for that dashboard. Holding a role (ceo, cfo, ...) no
-- longer counts as being on the list. super_admin and cto keep their bypass so
-- the list can always be managed. Public-user dashboards are not affected.
--
-- Before this: seven roles (access_admin, super_admin, manager, agent_ops,
-- operations, coo, ceo) could insert/update staff_permissions straight from the
-- browser, and hr/cto could not.

-- ── 1. Valid dashboard keys (one list for the server) ───────────────────────
CREATE OR REPLACE FUNCTION public.dashboard_access_keys()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY[
    'ceo','cto','cfo','coo','cmo','crm','director','financial-ops','company-ops',
    'platform-users','agent-ops','tenant-ops','landlord-ops','partner-ops','hr',
    'rd','kyc','agents-space'
  ]::text[];
$function$;

-- ── 2. Who may manage the allowlist ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.can_manage_dashboard_access(_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.has_role(_user_id, 'super_admin'::app_role)
      OR public.has_role(_user_id, 'cto'::app_role)
      OR public.has_role(_user_id, 'hr'::app_role);
$function$;

-- ── 3. Grant ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.grant_dashboard_access(p_user_id uuid, p_dashboard text, p_reason text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing uuid;
  v_id uuid;
BEGIN
  IF v_actor IS NULL OR NOT public.can_manage_dashboard_access(v_actor) THEN
    RAISE EXCEPTION 'Only super_admin, CTO or HR can grant dashboard access' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_required' USING ERRCODE = '22023';
  END IF;
  IF p_dashboard IS NULL OR NOT (p_dashboard = ANY (public.dashboard_access_keys())) THEN
    RAISE EXCEPTION 'Unknown dashboard: %', p_dashboard USING ERRCODE = '22023';
  END IF;

  -- One active grant per person per dashboard.
  PERFORM pg_advisory_xact_lock(hashtext('dash-access-' || p_user_id::text || '-' || p_dashboard));
  SELECT id INTO v_existing FROM public.staff_permissions
   WHERE user_id = p_user_id AND permitted_dashboard = p_dashboard AND revoked_at IS NULL
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_granted', true, 'id', v_existing);
  END IF;

  INSERT INTO public.staff_permissions (user_id, permitted_dashboard, granted_by, granted_at)
  VALUES (p_user_id, p_dashboard, v_actor, now())
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, new_values)
  VALUES (v_actor, 'dashboard_access_granted', 'staff_permissions', v_id::text,
          format('Granted %s dashboard access', p_dashboard), nullif(btrim(coalesce(p_reason, '')), ''),
          jsonb_build_object('user_id', p_user_id, 'dashboard', p_dashboard));

  RETURN jsonb_build_object('ok', true, 'already_granted', false, 'id', v_id);
END;
$function$;

-- ── 4. Revoke (an UPDATE, never a DELETE: the history stays) ────────────────
CREATE OR REPLACE FUNCTION public.revoke_dashboard_access(p_user_id uuid, p_dashboard text, p_reason text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_count int;
BEGIN
  IF v_actor IS NULL OR NOT public.can_manage_dashboard_access(v_actor) THEN
    RAISE EXCEPTION 'Only super_admin, CTO or HR can revoke dashboard access' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_dashboard IS NULL THEN
    RAISE EXCEPTION 'user_and_dashboard_required' USING ERRCODE = '22023';
  END IF;

  UPDATE public.staff_permissions
     SET revoked_at = now(), revoked_by = v_actor,
         revoke_reason = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Revoked')
   WHERE user_id = p_user_id AND permitted_dashboard = p_dashboard AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count > 0 THEN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, old_values)
    VALUES (v_actor, 'dashboard_access_revoked', 'staff_permissions', p_user_id::text,
            format('Revoked %s dashboard access', p_dashboard), nullif(btrim(coalesce(p_reason, '')), ''),
            jsonb_build_object('user_id', p_user_id, 'dashboard', p_dashboard, 'rows', v_count));
  END IF;

  RETURN jsonb_build_object('ok', true, 'revoked', v_count);
END;
$function$;

REVOKE ALL ON FUNCTION public.can_manage_dashboard_access(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.grant_dashboard_access(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_dashboard_access(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_dashboard_access(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.grant_dashboard_access(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_dashboard_access(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dashboard_access_keys() TO authenticated, service_role;

-- ── 5. Lock the table: no direct browser writes ─────────────────────────────
DROP POLICY IF EXISTS "Authorized staff grant permissions" ON public.staff_permissions;
DROP POLICY IF EXISTS "Authorized staff revoke permissions" ON public.staff_permissions;
DROP POLICY IF EXISTS "Authorized staff read permissions" ON public.staff_permissions;

-- Reading who holds what stays open to the staff who already read it (minus
-- the retired access_admin) plus cto and hr. People always read their own rows
-- via the existing "Users read own permissions" policy.
CREATE POLICY "Authorized staff read permissions" ON public.staff_permissions
  FOR SELECT TO authenticated
  USING (
    public.can_manage_dashboard_access(auth.uid())
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'agent_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
  );

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.staff_permissions FROM authenticated, anon;
REVOKE SELECT ON public.staff_permissions FROM anon;

-- ── 6. Staff-role assignment: access_admin's place goes to cto and hr ───────
DROP POLICY IF EXISTS "Staff roles except master managed by access admins" ON public.user_roles;
DROP POLICY IF EXISTS "Staff roles except master updated by access admins" ON public.user_roles;

CREATE POLICY "Staff roles except master managed by access managers" ON public.user_roles
  FOR INSERT TO authenticated
  WITH CHECK (
    (NOT public.is_public_role(role)) AND role <> 'super_admin'::app_role
    AND public.can_manage_dashboard_access(auth.uid())
  );

CREATE POLICY "Staff roles except master updated by access managers" ON public.user_roles
  FOR UPDATE TO authenticated
  USING (
    (NOT public.is_public_role(role)) AND role <> 'super_admin'::app_role
    AND public.can_manage_dashboard_access(auth.uid())
  )
  WITH CHECK ((NOT public.is_public_role(role)) AND role <> 'super_admin'::app_role);

-- ── 7. Retire access_admin ──────────────────────────────────────────────────
-- Several functions read user_roles directly without an enabled filter, so a
-- disabled row would still count. Remove the rows (recorded in audit_logs so
-- they can be restored) and refuse the role from now on. The enum value stays:
-- Postgres cannot safely drop one.
INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, old_values)
SELECT NULL, 'role_retired', 'user_roles', ur.user_id::text,
       'Retired role access_admin', 'access_admin role retired; dashboard allowlist now managed by super_admin, cto, hr',
       to_jsonb(ur)
FROM public.user_roles ur WHERE ur.role = 'access_admin'::app_role;

DELETE FROM public.user_roles WHERE role = 'access_admin'::app_role;

CREATE OR REPLACE FUNCTION public.block_retired_roles()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.role = 'access_admin'::app_role THEN
    RAISE EXCEPTION 'The access_admin role is retired. Dashboard access is granted by super_admin, CTO or HR.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_block_retired_roles ON public.user_roles;
CREATE TRIGGER trg_block_retired_roles
  BEFORE INSERT OR UPDATE OF role ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.block_retired_roles();
