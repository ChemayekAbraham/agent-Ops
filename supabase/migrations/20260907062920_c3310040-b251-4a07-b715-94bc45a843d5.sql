DROP POLICY IF EXISTS "Admins grant permissions" ON public.staff_permissions;
DROP POLICY IF EXISTS "Admins revoke permissions" ON public.staff_permissions;
DROP POLICY IF EXISTS "Admins read all permissions" ON public.staff_permissions;
DROP POLICY IF EXISTS "Authorized staff manage permissions" ON public.staff_permissions;
DROP POLICY IF EXISTS "Authorized staff read permissions" ON public.staff_permissions;

CREATE POLICY "Authorized staff read permissions" ON public.staff_permissions
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'access_admin'::public.app_role)
    OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
    OR public.has_role(auth.uid(), 'manager'::public.app_role)
    OR public.has_role(auth.uid(), 'agent_ops'::public.app_role)
    OR public.has_role(auth.uid(), 'operations'::public.app_role)
    OR public.has_role(auth.uid(), 'coo'::public.app_role)
    OR public.has_role(auth.uid(), 'ceo'::public.app_role)
  );

CREATE POLICY "Authorized staff grant permissions" ON public.staff_permissions
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'access_admin'::public.app_role)
    OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
    OR public.has_role(auth.uid(), 'manager'::public.app_role)
    OR public.has_role(auth.uid(), 'agent_ops'::public.app_role)
    OR public.has_role(auth.uid(), 'operations'::public.app_role)
    OR public.has_role(auth.uid(), 'coo'::public.app_role)
    OR public.has_role(auth.uid(), 'ceo'::public.app_role)
  );

CREATE POLICY "Authorized staff revoke permissions" ON public.staff_permissions
  FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'access_admin'::public.app_role)
    OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
    OR public.has_role(auth.uid(), 'manager'::public.app_role)
    OR public.has_role(auth.uid(), 'agent_ops'::public.app_role)
    OR public.has_role(auth.uid(), 'operations'::public.app_role)
    OR public.has_role(auth.uid(), 'coo'::public.app_role)
    OR public.has_role(auth.uid(), 'ceo'::public.app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'access_admin'::public.app_role)
    OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
    OR public.has_role(auth.uid(), 'manager'::public.app_role)
    OR public.has_role(auth.uid(), 'agent_ops'::public.app_role)
    OR public.has_role(auth.uid(), 'operations'::public.app_role)
    OR public.has_role(auth.uid(), 'coo'::public.app_role)
    OR public.has_role(auth.uid(), 'ceo'::public.app_role)
  );

GRANT SELECT, INSERT, UPDATE ON public.staff_permissions TO authenticated;
GRANT ALL ON public.staff_permissions TO service_role;