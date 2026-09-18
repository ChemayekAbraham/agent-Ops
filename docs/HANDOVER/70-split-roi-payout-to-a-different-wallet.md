# 70 — Split ROI Payout can now send the cash portion to a different person's wallet

**Built 2026-09-18, on the Partner Ops "Nearing Payouts" panel and the COO Partners page's Split
Payout dialog. Read this before touching `handleSplitPayout` / `NearingPayoutsDialog`
(`src/components/coo/COOPartnersPage.tsx`) or `approve-wallet-operation`'s `ledgerUserId`
derivation again.**

## What was asked

Relayed from the boss via Josh: on Partner Ops, staff need to split a partner's pending Returns
(ROI) and send part of it straight to a *different person's* Welile wallet, the rest to be
withdrawn normally. Concrete example: a 10M ROI, 5M redirected to Benjamin Muhanguzi's own wallet,
5M withdrawn as usual by the original partner.

## Why this design, not a new payout pipeline

I initially planned new tables + OTP + a FinOps approval queue, because
`enforce_withdrawal_payout_account_lock` (deployed 2026-09-13, closing a real disputed-withdrawal
incident) blocks any `withdrawal_requests` row whose mobile-money number doesn't match the
partner's registered one. Per Josh's correction, the right mechanism was already in the codebase:
the existing **Split Payout** flow (`NearingPayoutsDialog` in `COOPartnersPage.tsx`) already
splits a portfolio's ROI into a cash leg (`pending_wallet_operations`, COO→CFO approval) and a
reinvest/keep-as-returns leg — and `pending_wallet_operations.target_wallet_user_id` already
exists and is already used to route a managed-proxy partner's ROI to their proxy agent's wallet
instead of their own. This never touches `withdrawal_requests` or the lock trigger at all, so no
changes were needed there.

## What changed

- **`src/components/coo/COOPartnersPage.tsx`** — Split Payout's "Cash portion payment method"
  dropdown gained a third option, "Pay to a different person's wallet," backed by the existing
  `UserSearchPicker` (`src/components/cfo/UserSearchPicker.tsx`, previously only used by
  `DirectCreditTool.tsx`). Picking a recipient sets `target_wallet_user_id` on the
  `pending_wallet_operations` insert (`operation_type: 'roi_split_alt_wallet'`) instead of the
  usual `null`. Still goes through the same mandatory COO→CFO approval as every other split — the
  approvers see exactly who the money is headed to before it moves.
- **`supabase/functions/approve-wallet-operation/index.ts`** — `ledgerUserId` previously came only
  from a *live* `resolveManagedProxy(op.user_id)` re-check, completely ignoring any stored
  `target_wallet_user_id` for the purpose of deciding who actually gets credited (it was read
  elsewhere only for display/notification routing). Now an explicit `target_wallet_user_id` on a
  `roi_split_alt_wallet` op wins over the proxy lookup — `isManaged` is deliberately kept `false`
  in this case so the description/notification text isn't mislabeled as a proxy payout.
- **`src/lib/supabaseBatchUtils.ts`** — extracted the nearing-payout list-building +
  already-paid/already-queued dedupe (previously duplicated, differently, in both
  `COOPartnersPage.tsx` and `NearingPayoutsPanel.tsx`) into one shared
  `fetchNearingPayoutPortfoliosWithDedupe()`. That dedupe is "the primary defence against
  duplicate/double ROI credits" per the original comment — it must not drift between the two
  screens that both need it.
- **`src/components/executive/partner-ops/NearingPayoutsPanel.tsx`** — this is the actual "Nearing
  Payouts" surface on the Partner Ops dashboard, and it previously had zero payout actions (list
  only). It now imports and reuses `NearingPayoutsDialog` from `COOPartnersPage.tsx` behind a new
  "Pay / Split Payouts" button, fed by the same shared dedupe fetch as its own table — the table
  and the dialog can no longer disagree about which portfolios are still payable.

## Follow-up fixes, same day, after a live test

Josh tested it live (Piuslubega Ssenkali → Joshua Wanda, UGX 1,000 of a 2,000 total) and caught
two real problems immediately:

1. **The untouched UGX 1,000 got reinvested into Piuslubega's portfolio principal**, not left
   withdrawable. Split Payout's pre-existing "Reinvest vs Keep as Returns" toggle defaults to
   Reinvest, and a fresh `different_wallet` split doesn't change that default on its own. Josh's
   call: the whole point of redirecting part of a payout to someone else is that the REST is
   always withdrawable by the original partner — never silently compounded. Fixed as a hard
   invariant, not just a default: picking "Pay to a different person's wallet" now force-sets
   `splitReinvestMode` to `'keep_returns'` (both in the `onValueChange` handler and again inside
   `handleSplitPayout` itself as a defensive floor), and the "Reinvest" tile is visually disabled
   while that payment method is selected so it can't be re-toggled by mistake.
2. **The approval card badged Joshua Wanda as "Proxy Agent."** Traced this fully before touching
   anything — confirmed it is cosmetic-only, not a real relationship: `get_agent_proxy_roi_payouts()`
   (the RPC that actually populates an agent's own "Proxy Partners" queue,
   `src/components/agent/ProxyPartnerFunds.tsx`) INNER JOINs to an active, approved
   `proxy_agent_assignments` row for that exact agent+partner pair — nothing in this feature
   creates or touches that table, so a `roi_split_alt_wallet` op can never actually surface there.
   The bug was purely display: `COOROIApprovals.tsx`, `CFOROIRequests.tsx`, and
   `ROIPayoutQueue.tsx` all badge *any* op with `target_wallet_user_id` set as "Proxy Agent" with
   no check on `operation_type`. Fixed in all three — a `roi_split_alt_wallet` op now shows
   "Different Wallet" (reading `metadata.alt_recipient_name`) instead.

The UGX 1,000 test row (`pending_wallet_operations.id = 9494b992-9a36-4d70-b8b3-62601b35c708`,
ref `SPL-MU6RMYEL-J9KM`) was rejected directly in production per Josh's instruction — it never
reached CFO approval, so no ledger entry or wallet credit was ever created; the reject is pure
cleanup of a `pending_coo_approval` row.

## The real bug: "Keep as Returns" never actually credited the wallet

Josh reported the balance was still reinvesting even after fix #1 above forced `keep_returns`.
The mode-forcing fix was correct but insufficient — "Keep as Returns" itself was already broken,
**pre-existing, not something this feature introduced**. In `handleSplitPayout`'s reinvest ledger
RPC call, the recipient-side leg (`category: isKeepReturns ? 'roi_wallet_credit' : 'roi_reinvestment'`)
had `ledger_scope: 'platform'` hardcoded unconditionally on *both* branches.

Verified directly against the live `create_ledger_transaction` and `wallet_route_for_category`
function bodies (`pg_get_functiondef`, not the repo migrations, per the standing
migrations-diverge-from-production gotcha): a `general_ledger` row only counts toward a user's
withdrawable balance when `ledger_scope = 'wallet'` — `'platform'`-scope rows are invisible to
both the balance-availability check inside `create_ledger_transaction` and (by the same
`wallet_route_for_category` routing) whatever computes the live balance. So even when
`category: 'roi_wallet_credit'` correctly matched what `process-supporter-roi`/
`approve-wallet-operation` use elsewhere, the explicit `ledger_scope: 'platform'` silently kept
the money out of the wallet every time "Keep as Returns" was ever used — this predates the
`different_wallet` feature entirely, just never got noticed because nothing forced that mode
before.

Fixed: `ledger_scope: isKeepReturns ? 'wallet' : 'platform'`, plus `recipient_type: 'user'` and
`wallet_bucket: 'withdrawable'` on that leg when `isKeepReturns`, matching the exact field set
`process-supporter-roi/index.ts` and `approve-wallet-operation/index.ts` already use for a
genuine `roi_wallet_credit`. The true-reinvest branch (`category: 'roi_reinvestment'`) is
untouched — that leg correctly stays platform-scope, since no wallet money should move when ROI
compounds into portfolio principal instead.

## Verification

- `npm run guard:all` — all 7 guards passed, including `guard:frontend-ledger-writes` (this
  feature only ever writes `pending_wallet_operations`, never the ledger, from the frontend).
- Note for next session: running `guard:all` on this Windows checkout regenerated
  `supabase/functions/mcp/index.ts`, `mcp-public/index.ts`, and both `sitemap*.xml` down to a
  fraction of their real size — the known Windows-build corruption bug
  (`project_mcp_js_windows_build_bundle_bug`). Reverted with `git checkout --` before committing;
  re-check those 4 files after any local guard/build run before pushing.
