-- 2026-10-20 (doc 247, step 33): public.wallets runs as the caller (security_invoker) instead of with owner rights.
-- The view's own gate was: own wallet, wallet network (agent_wallet_network_ids), or staff (can_view_staff_reports). The same predicate is now a row-level security
-- policy on both tables the view reads, so ~60 screens keep working with no code change and the linter's Security Definer View error clears for this view.
-- Tested before applying (rolled back): staff see all 97,575 rows in 0.05 s (0.04 s before); a non-staff user asking for self + a stranger gets only self.
-- Applied to production 2026-10-20. Undo: alter view public.wallets set (security_invoker = false); drop policy a_wallet_view_gate on both tables.
set lock_timeout = '5s';
create policy a_wallet_view_gate on public.wallets_physical for select to authenticated
  using (user_id in (select public.agent_wallet_network_ids((select auth.uid()))) or (select public.can_view_staff_reports((select auth.uid()))));
create policy a_wallet_view_gate on public.wallet_balances_projection for select to authenticated
  using (user_id in (select public.agent_wallet_network_ids((select auth.uid()))) or (select public.can_view_staff_reports((select auth.uid()))));
alter view public.wallets set (security_invoker = true);
