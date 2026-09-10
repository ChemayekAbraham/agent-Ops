REVOKE EXECUTE ON FUNCTION public.get_merchant_agent_money_owed() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_merchant_agent_money_owed() TO authenticated, service_role;