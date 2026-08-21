REVOKE ALL ON FUNCTION public.lock_portfolio_principal(uuid, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_portfolio_principal(uuid, numeric, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.lock_portfolio_principal(uuid, numeric, text) TO authenticated;