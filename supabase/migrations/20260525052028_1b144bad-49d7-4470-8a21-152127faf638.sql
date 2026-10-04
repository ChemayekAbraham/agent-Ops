
ALTER VIEW public.rent_request_formula_drift SET (security_invoker = on);
ALTER VIEW public.v_agent_daily_eligibility SET (security_invoker = on);
ALTER VIEW public.v_operational_float_tid_duplicates SET (security_invoker = on);
ALTER VIEW public.v_pivot_drift SET (security_invoker = on);
ALTER VIEW public.v_user_wallet_strict SET (security_invoker = on);
ALTER VIEW public.wallets SET (security_invoker = on);

REVOKE ALL ON public.mv_house_location_rollup FROM anon, authenticated;
REVOKE ALL ON public.platform_stats FROM anon, authenticated;
