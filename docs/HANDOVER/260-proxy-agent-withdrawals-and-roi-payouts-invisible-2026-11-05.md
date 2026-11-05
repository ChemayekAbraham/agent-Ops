# 260 — Proxy agent could not see her partner withdrawals or approved ROI payouts (2026-11-05)

**Applied to production 2026-11-05 (two migrations), verified as Kabahuma Lillian.** Read this before touching
`agent_proxy_withdrawal_summaries`, `agent_onboarded_portfolios`, `ProxyRecentPayouts.tsx` or `ProxyPartnerFunds.tsx`.

## What was reported

Proxy agent Kabahuma Lillian (`5f277e34-a830-4ebb-8680-c0c074b279da`) makes withdrawals for partners. Her Proxy Partners
screen showed the red error "Could not find the function public.agent_proxy_withdrawal_summaries without parameters in the
schema cache". After that was fixed, "No proxy partner payouts ready" stayed empty although the CFO (Sarah Angwen) had approved
68 ROI payouts that morning, and recent payouts showed "Name not available".

## Root cause 1 — a function the deployed frontend calls did not exist

Commit `264d3a09f4` (Cursor Agent, 11-04, "Add Nexa partner portfolio tools and close open partner reads") added
`fetchAgentProxyWithdrawals()` (`src/lib/agentPartnerPortfolios.ts`), which calls `agent_proxy_withdrawal_summaries()`. The function is
defined in `supabase/migrations/20261104244000_partner_portfolio_read_scope.sql`. When checked, production had every other function from that
migration (and its trigger, policy drops and restrictive policy) but not this one. `schema_migrations` has no row for that version, so it was
applied outside the normal path, apparently in part. Reloading the schema cache could not help: the function was absent.

**Fix:** `supabase/migrations/20261105113000_agent_proxy_withdrawal_summaries.sql` (rollback: same name ending `.rollback.sql`). Creates only that
function. Read-only, `security definer`, `search_path = public`, no payout numbers, revoked from `public` and `anon`, granted to `authenticated`
and `service_role`. Returns the caller's rows where `agent_id` or `initiated_by` is the caller and `proxy_partner_id` or `linked_party` is set,
newest first, capped at 500.

Verified: all 14 columns it reads exist; Lillian has 3,573 withdrawals made for partners and all match the filter (her own 16 personal withdrawals
do not, by design); called as her it returns 500 rows (the cap).

## Root cause 2 — the portfolio lookup could not resolve proxy partners

`ProxyPartnerFunds.tsx` takes the approved ROI payouts from `get_agent_proxy_roi_payouts` and maps each `source_id` (portfolio) to a partner through
`agent_onboarded_portfolios()`. It drops any payout it cannot map. The function returned only portfolios with `investor_portfolios.agent_id = caller`
plus one placeholder row (null `portfolio_id`) per active assignment, capped at 200. Lillian has 836 active proxy partners and 1,281 portfolios but
only 2 portfolios list her as `agent_id`, so she got 200 placeholders and no real portfolio. All 77 approved ROI rows were dropped and every partner
name fell back to "Name not available".

**Fix:** `supabase/migrations/20261105130000_agent_onboarded_portfolios_include_proxy_partners.sql` (rollback restores the 11-04 definition).
Same return type, same masked code, no payout numbers. It now also returns the real portfolios of every partner with an active, **approved**
`proxy_agent_assignments` row for the caller, keeps a placeholder only for an assignment with no portfolio, and the cap is 5000. Neither function
is in `critical_function_baselines` (checked 2026-11-05), so no re-baseline.

Verified as Lillian: 1,315 rows, 1,281 with a real portfolio, 0 unnamed, and 77 of 77 approved ROI rows now map to a partner (before: 0 of 77).

## What the 68 ROI payouts are (do not confuse with withdrawals)

The General Payout Activity table on the CFO page lists `pending_wallet_operations` rows with `category = 'roi_payout'`, `operation_type = 'roi_wallet_credit'`.
On 11-05 there were 68 approved between 11:00 and 12:15 East Africa time, UGX 147,265,062 across 65 partners, 67 routed to Lillian's wallet
(`target_wallet_user_id`). These are wallet credits, not `withdrawal_requests`, so `agent_proxy_withdrawal_summaries()` never returns them. They are
shown by the "ready" section of `ProxyPartnerFunds`, which is why root cause 2 hid them.

## Open items

- **The 11-04 partner-scope migration is live but unrecorded.** The trigger `trg_00_proxy_copy_payout_on_file`, `copy_proxy_payout_on_file`,
  `agent_own_promissory_notes`, `partner_record_staff_ok`, the restrictive payout-destination policy and the dropped agent/proxy/anon read policies are in
  production. `schema_migrations` has no row. Find out who applied it and how. Its risks (silent null payout destination when `payout_route_ref` is missing
  or fails the ownership check; the restrictive policy applying to every authenticated role outside its hard-coded list; other screens still reading the
  tables that lost access) were not re-verified.
- **Settlement filter.** `ProxyPartnerFunds` also drops payouts already settled by a delivered withdrawal. If the screen shows fewer than 77, that is the
  likely reason. It was not checked in the live UI.
- **500-row cap** on `agent_proxy_withdrawal_summaries()`: Lillian has 3,573 and sees the latest 500.
- **Duplicate doc numbers** exist in this folder (256, 257 and 259 each appear twice). This doc takes 260.

## Not touched

Frontend code, grants on tables, the trigger, and the live policies were not changed by this work.
