-- 2026-10-26: two regressions from the function lockdown (doc 247 step 23), found in the 2026-10-26 13:07 UTC log export and the 24h API status counts.
--
-- 1. public.rent_access_limit_server(uuid): the browser calls it (POST /rest/v1/rpc/rent_access_limit_server) and got 403 "permission denied for function" (593 times in 24h).
--    Its own migration (20261014200000) grants it to authenticated; the lockdown closed it. Safe to reopen: SECURITY DEFINER but checks the caller itself
--    (auth.uid() required; caller must be the tenant or pass _can_renew_rent_request). anon stays closed.
-- 2. public._ledger_can_post_partner_returns(uuid) and public._return_cycle_can_request(uuid): plain boolean role checks used INSIDE RLS policies
--    (portfolio_return_cycle_claims, portfolio_return_cycle_overrides, compound_reversal_requests). A policy can only call a function the caller may execute, so closing them made
--    every read of those tables fail with 403 (1,485 in 24h on portfolio_return_cycle_claims). Same class as has_role; reopening is safe.
--
-- Sweep: no policy in public now depends on a function that authenticated cannot execute (checked via pg_depend). Applied to production 2026-10-26 by hand; tested as an
-- investor on portfolio_return_cycle_claims (403 -> ok).
grant execute on function public.rent_access_limit_server(uuid) to authenticated;
grant execute on function public._ledger_can_post_partner_returns(uuid), public._return_cycle_can_request(uuid) to authenticated;
