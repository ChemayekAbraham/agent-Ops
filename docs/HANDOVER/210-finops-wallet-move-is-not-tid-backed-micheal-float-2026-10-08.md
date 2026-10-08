# 210 — A FinOps wallet move into an agent's Float is not TID-backed float (Okwakol Micheal)

**Status: dialog fix BUILT 2026-10-08, not deployed (`RouteEmailDepositDialog.tsx`, ships with the next `lovable` merge). The operator reversed the move themselves (FXW-24B78D86C1, 11:11 UTC). The real payment (TID158315386626) is NOT yet routed to Micheal; that is a FinOps UI step.**
Instructed by Joshua Wanda, carried out by Claude.

## What was reported
A FinOps operator tried to give agent Okwakol Micheal (`75891dff-d684-49e9-83ea-fab6e4cb4ded`, +256793487307) UGX 10,000 of float. The float showed on his wallet but he still could not allocate a tenant payment.

## What was found (live, 2026-10-08)
- The operator used Wallet Move (`finops-wallet-move`, user_to_user, Withdrawable → Float) from **Nankambo sharimah** (`59d45ad2-0d44-433c-b4ec-20927a25c281`). Ledger group `c7bc3457-…`, reference `FXW-069F70B2E4`, 08:51 UTC, `bucket_reclass_out` / `bucket_reclass_in`.
- `tg_credit_tid_backed_float` counts only (a) `agent_float_deposit` from `deposit_requests` with a matching gmail TID, (b) `agent_float_deposit` from `cfo_direct_credit` whose `sub_category` is a real `gmail_transactions.transaction_id` (doc 113), (c) `bucket_reclass_in` from `agent_withdrawable_to_float`. A `finops_wallet_move` reclass matches none, so `agent_tid_backed_float.balance` stayed **0** and the rent gate refused ("TID-backed balance: 0").
- The real money was a separate payment: Airtel **TID158315386626**, UGX 10,000 from **0730647169** (the operator's own line) at 05:57 UTC. It was never credited to anyone. At 05:58 the auto-matcher linked it **by amount only** to Pauline Asianut's pending `partnership_deposit` request `100d839e-…` (a different TID, 158306223103).
- **Root cause of the routing failure (screenshot toast: "Reversal failed: This request could not be completed."):** `RouteEmailDepositDialog` looks up a "prior auto-credit" through `gmail_transactions.linked_deposit_request_id` and treated any request not rejected/cancelled/failed/reversed as credited. The amount-only match left the email linked to Pauline's **pending** request, so the dialog first sent a `debit` ("Reverse auto-credit") for Pauline, which a non-approver is refused (and an approver would have debited money never credited and marked her request `reversed`). Fixed: only `status = 'approved'` counts as a prior credit.
- Why the 403: the generic CFO-approver message. FinOps staff who are not the designated CFO approver may only route an email receipt (non-manual, `gmail_transaction_id`, `wallet_deposit`/`agent_float_deposit`, amount = receipt). A manual float credit is refused, and would not have been TID-backed anyway.

## What was built, and why it was withdrawn
The reversal migration was withdrawn (below); the only shipped change is the dialog query fix above. Claude drafted migration `20261008100000` to reverse `FXW-069F70B2E4`, then removed it: the operator did the reversal in Wallet Move at 11:11 UTC (`FXW-24B78D86C1`, Micheal Float -> Nankambo Withdrawable, 10,000), and the draft refused to run ("Micheal float 0 is below 10000"). Kept out on purpose: once the TID is routed Micheal has 10,000 float again, which the draft's guard would have accepted and wrongly clawed back. Never run a reversal keyed only on float balance.

## Still to do (not done by Claude)
0. **Josh chose SQL (2026-10-08): migration `20261008140000_route_tid158315386626_to_micheal_float.sql`** posts the TID-backed float credit directly (mirrors his 5 Oct routed credit: `agent_float_deposit`/`cfo_direct_credit`/`sub_category`=TID, platform offset, `email_credit_idempotency` row) and rolls back unless `agent_tid_backed_float` rises by exactly 10,000. It also inserts the `platform_wallet_corrections` evidence row that `enforce_wallet_correction_evidence` requires for every `cfo_direct_credit` leg (first attempt failed `WALLET_CORRECTION_EVIDENCE_MISSING`); authored as Josh Wanda (cfo) on his explicit instruction, with the evidence text saying it was inserted by SQL because the dialog failed. **Not applied.** After it lands the operator must NOT press Credit in the dialog again (idempotency row blocks a duplicate, but don't try).
0b. Deploy the dialog fix (merge to `lovable`, Josh's go-ahead, Lovable agent idle). Until then routing this email stays blocked.
1. (Only if the SQL route is not used) FinOps: Email Transactions → row TID158315386626 → **Send to wallet / Route** → Micheal → Operational Float → exactly 10,000. Then verify `agent_tid_backed_float.balance` = 10,000 (if 0, fix his row by exact amount as in doc 113; no platform recompute).
2. Unlink or reject Pauline's pending request `100d839e-…`. With the fix it no longer blocks routing, but the amount-only link is still wrong (3 other pending-linked inbound emails in the last 14 days).
3. Micheal's float is 0 and TID-backed is 0 until step 1 is done.

## What not to do
- Don't use the manual Direct Credit form to "route" a real payment: it carries a generic `sub_category`, so it is never TID-backed, and a non-approver is refused.
- Don't count `finops_wallet_move` as TID-backed platform-wide; it reopens the hole the TID rule closes.
