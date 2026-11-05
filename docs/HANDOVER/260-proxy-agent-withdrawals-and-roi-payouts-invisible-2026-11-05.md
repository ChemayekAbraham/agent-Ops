# 260 — Proxy agent could not see her partner withdrawals or approved ROI payouts (2026-11-05)

**Applied to production 2026-11-05 (five migrations), verified as Kabahuma Lillian; dialog fixes pushed to `lovable` (`9af0a3be2d`, `847b83f960`).**
Read this before touching `agent_proxy_withdrawal_summaries`, `agent_onboarded_portfolios`, `agent_partner_payout_routes`,
`agent_partner_payout_destination`, `copy_proxy_payout_on_file`, `WithdrawRequestDialog.tsx`, `ProxyRecentPayouts.tsx` or `ProxyPartnerFunds.tsx`.

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

## Root cause 3 — the payout-route lookup hid portfolio routes from proxy agents

Reported: when Lillian withdraws for a partner the destination used to be filled in (by Partner Ops, from the partner's portfolio) so she typed
nothing; now it was missing. Her history confirms it: from 19 May to 4 Nov she paid partners on every working day (typically 20-40 a day, 75-143 on
Mondays), every row carried a destination, and since about 7 Aug every row carried a `portfolio:` route reference. On 4 Nov she paid 34 partners, all
through a portfolio route.

`agent_partner_payout_routes(p_partner_id)` (migration 20261104244000) authorised the caller by `agent_id` OR an active assignment, but its portfolio
and extra branches then also required `investor_portfolios.agent_id = caller`. Lillian is `agent_id` on 2 portfolios and the assigned proxy of 836
partners, so 764 partners with portfolio details showed her no route. Only the partner's saved methods came through: 9 of the 34 partners she paid on
4 Nov showed a route and 25 (all bank transfer) showed "No payment details on file". Over her whole history 255 of 775 partners showed a route.
The insert trigger `copy_proxy_payout_on_file` already accepted `agent_id` or an active assignment, so only the route list was wrong.

**Fix:** `supabase/migrations/20261105140000_agent_partner_payout_routes_follow_assignment.sql` (rollback: same name ending `.rollback.sql`). The
portfolio and extra branches now match on the partner (`investor_id`) after the `allowed` check, and the assignment path needs
`approval_status = 'approved'`. Same columns, generic labels, no payout numbers. Not on `critical_function_baselines` (checked 2026-11-05); none of
Lillian's active assignments were unapproved.

Verified as Lillian after applying: 34 of 34 partners paid on 4 Nov get a route (was 9); 746 of the 775 partners she has ever paid get a route (was
255). The other 29 were not itemised; most are probably no longer her active, approved assignments, which is correct. 4 partners have no payout details
anywhere.

## Root cause 4 — the withdraw dialog prefilled the agent's own MoMo number

`WithdrawRequestDialog.tsx` loaded the signed-in user's saved MoMo number whenever `prefillPayout` was empty. Since `264d3a09f4` the proxy flow passes
`payoutOnFile` instead, so the guard missed it and Lillian's own number (`+256706662454`) showed as the payout number. No stored withdrawal carried it:
none of her proxy rows in the last 10 days, and none of her partners' portfolios, held her number, because the trigger copies the partner's
destination.

**Fix (code, no migration):** commit `9af0a3be2d` on `dev/proxy-withdraw-no-own-number`, fast-forwarded onto `origin/lovable` on 2026-11-05 after
checking Lovable's agent was idle (`agentFinished: true`). In proxy mode (`linkedParty` or `payoutOnFile`) the dialog clears the number and never reads
the agent's profile. Lovable confirmed it is on `9af0a3be2d` and will not touch the change. `tsc` and `guard:all` could not be run (tsc runs out of
memory locally; the worktree had no `node_modules`) and the live screen was not tested.

## Root cause 5 — the confirm screen showed no destination, and the insert trigger skipped staff-role agents

**Confirm screen.** After the 11-04 privacy change the withdraw dialog's confirm step read "via —": the destination came only from the agent's own
profile (the bug in cause 4), and `payoutOnFile` carried only a label. Decision (CTO, 2026-11-05): the assigned proxy must see the partner's holder
name and number to confirm. `supabase/migrations/20261105150000_agent_partner_payout_destination.sql` adds `agent_partner_payout_destination(partner, route_key)`
(`security definer`, not granted to `anon`), which returns the name, number, bank and provider of ONE route of ONE partner the caller is `agent_id` of or
an active, approved proxy for. No table policy was loosened and `agent_partner_payout_routes` still returns labels only. Verified as Lillian: 122 routes
across the 34 partners paid on 4 Nov all returned name and number; 20 portfolios of other agents' partners returned nothing. Frontend: commit `e8091dc128`
(merged as `847b83f960`, pushed to `lovable` 2026-11-05) shows the destination read-only and locked on the confirm screen and sets `payoutOnFile` for
saved-method routes too (those left the form invalid and the button grey). Syntax-checked only; not tested in a browser.

**Insert trigger.** `copy_proxy_payout_on_file` (BEFORE INSERT on `withdrawal_requests`) returned immediately for anyone `partner_record_staff_ok()` accepts.
Lillian also holds `manager`, `coo`, `crm`, `operations` and `partner_ops`, so the trigger never copied the partner's destination for her, and since the
dialog stopped sending numbers her withdrawals were stored without one. Found on the test withdrawal `15a39110-168e-458b-98ea-24c94277ffbf` (OCHOKAN SAM,
route `portfolio:9481972b-…`, UGX 150,000, 10:12 UTC): mobile money with null number, name and provider although the portfolio has an MTN number. It was the
only such row since the trigger was created (8:42 UTC).

**Fix:** `supabase/migrations/20261105160000_copy_proxy_payout_for_staff_agents.sql` (rollback restores the 11-04 behaviour). Staff who typed their own number
or bank account keep it; otherwise the destination is copied from the chosen route as for any proxy agent. Not on `critical_function_baselines`. Verified as
Lillian on a throwaway table with the trigger attached: a mobile-money route gets number, provider and name; a bank route gets account number and bank
name; a number typed by staff is kept. No real withdrawal was created for the test.

**Open: `15a39110-168e-458b-98ea-24c94277ffbf` is still `pending` with no number** (last touched 10:18 UTC). The fix does not repair existing rows. Cancel it
and have the agent redo it, or patch the number deliberately (an update runs the other withdrawal triggers). If Financial Ops has already acted on it, check
what was sent before anything else.

## What the 68 ROI payouts are (do not confuse with withdrawals)

The General Payout Activity table on the CFO page lists `pending_wallet_operations` rows with `category = 'roi_payout'`, `operation_type = 'roi_wallet_credit'`.
On 11-05 there were 68 approved between 11:00 and 12:15 East Africa time, UGX 147,265,062 across 65 partners, 67 routed to Lillian's wallet
(`target_wallet_user_id`). These are wallet credits, not `withdrawal_requests`, so `agent_proxy_withdrawal_summaries()` never returns them. They are
shown by the "ready" section of `ProxyPartnerFunds`, which is why root cause 2 hid them.

## Open items

- **Who applied the 11-04 partner-scope migration: Lovable.** Its commit `e651c1c927` (11-05 09:02 UTC) is "Record PR 62 migrations applied (nexa access
  alerts, partner portfolio read scope)". `schema_migrations` still has no row for it, nor for this doc's three migrations (20261105113000,
  20261105130000, 20261105140000), which were applied from the SQL tool; anything that reconciles by that table will see them as unapplied. The trigger `trg_00_proxy_copy_payout_on_file`, `copy_proxy_payout_on_file`,
  `agent_own_promissory_notes`, `partner_record_staff_ok`, the restrictive payout-destination policy and the dropped agent/proxy/anon read policies are in
  production. `schema_migrations` has no row. Find out who applied it and how. Its risks (silent null payout destination when `payout_route_ref` is missing
  or fails the ownership check; the restrictive policy applying to every authenticated role outside its hard-coded list; other screens still reading the
  tables that lost access) were not re-verified.
- **Settlement filter.** `ProxyPartnerFunds` also drops payouts already settled by a delivered withdrawal. If the screen shows fewer than 77, that is the
  likely reason. It was not checked in the live UI.
- **500-row cap** on `agent_proxy_withdrawal_summaries()`: Lillian has 3,573 and sees the latest 500.
- **Partner data for Partner Ops:** 10 saved payout methods of her partners hold Lillian's own number (those partners would be paid to her), and 170 of
  her partners' portfolios have no payout details.
- **Migrations are not on `lovable` yet.** The three migrations and this doc are on `dev/financial-ops`; only the dialog fix is on `lovable`.
- **Duplicate doc numbers** exist in this folder (256, 257 and 259 each appear twice). This doc takes 260.

## Not touched

Table grants and the live table policies were not changed by this work.
