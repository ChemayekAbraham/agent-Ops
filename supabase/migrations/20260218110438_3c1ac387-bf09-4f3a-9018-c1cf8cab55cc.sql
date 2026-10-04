
-- Revoke public API access to platform_stats materialized view
REVOKE ALL ON public.platform_stats FROM anon, authenticated;

-- Grant only to service_role (edge functions) 
GRANT SELECT ON public.platform_stats TO service_role;

-- Also secure the existing materialized views
REVOKE ALL ON public.supporter_referral_leaderboard FROM anon;
