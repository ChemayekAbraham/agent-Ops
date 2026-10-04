CREATE POLICY "Partner ops, super admin and CTO can approve proxy funders"
ON public.proxy_agent_assignments
FOR UPDATE
TO authenticated
USING (
  public.has_role(auth.uid(), 'partner_ops'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'cto'::app_role)
)
WITH CHECK (
  public.has_role(auth.uid(), 'partner_ops'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'cto'::app_role)
);