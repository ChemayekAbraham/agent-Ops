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

## Known follow-up, not fixed here

`COOROIApprovals.tsx` / `CFOROIRequests.tsx` / `ROIPayoutQueue.tsx` badge anything with
`target_wallet_user_id` set as "proxy" for display. A `roi_split_alt_wallet` op will show that
badge even though it isn't a standing proxy relationship — cosmetic only (the operation's own
`description` and `metadata.pay_mode` are unambiguous), left alone to keep this change scoped to
the actual money-routing fix.

## Verification

- `npm run guard:all` — all 7 guards passed, including `guard:frontend-ledger-writes` (this
  feature only ever writes `pending_wallet_operations`, never the ledger, from the frontend).
- Note for next session: running `guard:all` on this Windows checkout regenerated
  `supabase/functions/mcp/index.ts`, `mcp-public/index.ts`, and both `sitemap*.xml` down to a
  fraction of their real size — the known Windows-build corruption bug
  (`project_mcp_js_windows_build_bundle_bug`). Reverted with `git checkout --` before committing;
  re-check those 4 files after any local guard/build run before pushing.
