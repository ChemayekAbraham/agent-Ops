DROP POLICY IF EXISTS tenant_support_contacts_read ON public.tenant_support_contacts;

CREATE POLICY tenant_support_contacts_read
ON public.tenant_support_contacts
FOR SELECT
TO authenticated
USING (
  public.is_ops_role(auth.uid())
  OR public.has_role(auth.uid(), 'manager'::public.app_role)
  OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
  OR public.has_role(auth.uid(), 'ceo'::public.app_role)
  OR public.has_role(auth.uid(), 'coo'::public.app_role)
  OR public.has_role(auth.uid(), 'cfo'::public.app_role)
);