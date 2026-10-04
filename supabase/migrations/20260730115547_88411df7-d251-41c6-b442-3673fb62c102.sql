ALTER VIEW public.v_tenant_ops_tenant_base SET (security_invoker = on);
ALTER VIEW public.v_tenant_ops_property_base SET (security_invoker = on);
ALTER VIEW public.v_tenant_ops_landlord_base SET (security_invoker = on);
REVOKE ALL ON public.v_tenant_ops_tenant_base FROM anon, authenticated;
REVOKE ALL ON public.v_tenant_ops_property_base FROM anon, authenticated;
REVOKE ALL ON public.v_tenant_ops_landlord_base FROM anon, authenticated;