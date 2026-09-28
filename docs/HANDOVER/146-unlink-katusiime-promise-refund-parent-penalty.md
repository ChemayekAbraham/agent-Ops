# 146 — Unlinked sub-agent Katusiime Promise; refunded parent's UGX 4,000 penalty

**Status: LIVE 2026-09-28.** Applied to production via `query_database`. The same block is saved as migration
`20260928130000_unlink_katusiime_promise_refund_parent_penalty.sql`, which is idempotent, so a re-apply is a no-op.

## Request
Josh asked for two things: unlink sub-agent **Katusiime Promise** (`1eaa4087-a367-463a-8bb0-aba1ed59524f`) from
parent **PROMROSE KATUSIIME** (`ffadf3bf-8ec7-46b0-b347-a8da55a443a7`), and reverse the parent's
"Parent-agent penalty: sub-agent Katusiime Promise had 3 listings rejected" charge
(`general_ledger` `d66edca5-34b6-4ed3-b5ff-eaa22bd7f346`, UGX 4,000, withdrawable, 2026-09-28 09:10 UTC,
listing `566bb564-…`).

## What was done
1. **Unlink.** This follows `admin_unlink_subagent`. The `agent_subagents` row `e528ddfa-…` (source `link_signup`, verified
   2026-06-27) was archived to `agent_subagent_link_archive` and deleted. No pending tenant transfers were cancelled because there were none.
   Listing blocks set by the parent were lifted, and a `subagent_made_independent` row was added to audit_logs. The sub-agent keeps its 1 active tenant.
   The RPC itself wasn't called because it needs `auth.uid()` with an ops role.
2. **Refund.** This uses the same shape as the 2026-07-22 KANUNA KEITH refund (`20260722094752`) and the idempotency key
   `refund_parent_rejection_penalty:<ledger id>`:
   - CR parent wallet, withdrawable, `system_balance_correction` cash_in 4,000
   - `listing_rejection_recovery` platform cash_out 4,000 (undoes the recovery leg)
   - a `parent_rejection_penalty_refund` row in audit_logs
3. **Sub-agent's own charge refunded** (10:39 UTC, after Josh's follow-up). The sub-agent's own UGX 4,000
   `listing_rejection_penalty` on the same listing (`bc0c9490-…`) got the same two legs under the new key
   `refund_listing_rejection_penalty:<ledger id>`, plus a `listing_rejection_penalty_refund` row in audit_logs.
   Both charges from this rejection now net to zero.
4. **Steps 2 and 3 didn't reach the wallets. Fixed at 11:09 UTC.** Josh said PROMROSE should show 24,000, but the wallet showed 20,000.
   The cause: `enforce_correction_classification` force-tags every `system_balance_correction` leg as `admin_correction`,
   and `wallet_strict_for_user` counts `admin_correction` legs **only when they're debits**. So the refund credits were in the
   ledger but left out of the wallet balance (and out of the financial statements). The fix re-posted each 4,000 as a production
   `listing_rejection_offset` withdrawable credit (key `refund_visible_fix:<penalty id>`). It's paired with a platform
   `system_balance_correction` cash_out that cancels the invisible credit, so production and `admin_correction`
   legs each net to 0. Verified after refreshing the stored balance: **PROMROSE withdrawable 24,000; Katusiime Promise 17,880.**

   **Wider bug, not fixed:** any refund posted as `system_balance_correction` cash_in never reaches the wallet. That includes the
   37 KANUNA KEITH parent-penalty refunds from 2026-07-22 (`refund_parent_rejection_penalty:` key). Those parents probably
   never received the refund in their spendable balance either. To credit a wallet, use a production category, not
   `system_balance_correction`.

## Not touched
- The `wallets.withdrawable_balance` cache showed 20,000 and was last updated 02:15 UTC. That's before both the penalty and
  the refund, so it refreshes on its own schedule rather than per posting. Check the parent's wallet screen after the next refresh.

## Note
The two names, "PROMROSE KATUSIIME" and "Katusiime Promise", look like they could be the same person with two accounts
(a self-referral). This wasn't investigated or acted on.
