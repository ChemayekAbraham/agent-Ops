REVOKE EXECUTE ON FUNCTION public.partner_ops_proxy_onboarding_audit(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.partner_ops_proxy_onboarding_audit(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.partner_ops_proxy_onboarding_audit(integer) TO authenticated;