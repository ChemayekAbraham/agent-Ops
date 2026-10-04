-- Allow Agent Ops, Operations, Managers, and Executives to manage staff_permissions
-- Fixes RLS violation when Agent Operations Managers grant/revoke Agents' Space access.

DROP POLICY IF EXISTS "Admins manage permissions" ON public.staff_permissions;
DROP POLICY IF EXISTS "Authorized staff manage permissions" ON public.staff_permissions;

CREATE POLICY "Authorized staff manage permissions" ON public.staff_permissions
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'agent_ops'::public.app_role)
    OR public.has_role(auth.uid(), 'operations'::public.app_role)
    OR public.has_role(auth.uid(), 'manager'::public.app_role)
    OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
    OR public.has_role(auth.uid(), 'coo'::public.app_role)
    OR public.has_role(auth.uid(), 'ceo'::public.app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'agent_ops'::public.app_role)
    OR public.has_role(auth.uid(), 'operations'::public.app_role)
    OR public.has_role(auth.uid(), 'manager'::public.app_role)
    OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
    OR public.has_role(auth.uid(), 'coo'::public.app_role)
    OR public.has_role(auth.uid(), 'ceo'::public.app_role)
  );
