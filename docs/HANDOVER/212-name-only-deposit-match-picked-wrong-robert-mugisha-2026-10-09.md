# 212 — Name-only deposit match credited the wrong Robert Mugisha (TID 44081020985, 2026-10-09)

**Status: BUILT 2026-10-09, migration `20261009100000_repoint_tid44081020985_robert_mugisha_misattach.sql` NOT applied.** Verify live after applying (see [06-live-state-verification.md](./06-live-state-verification.md)). The matcher itself is NOT changed (decision pending, see "Open").

## Incident

The tenant (Robert Mugisha, +256794402225, Rent Plan `ef5e2e18-e325-4d4a-b7c2-31d3cd974f54`, repaying) paid UGX 20,000 by MTN to Welile on 2026-10-08 18:22 EAT, TID `44081020985`. He got no confirmation SMS and the agent's dashboard showed nothing.

- The Gmail receipt (`gmail_transactions` `0de1c136-…`) arrived fine. The MTN "received" SMS carries **only the name** ("from ROBERT MUGISHA"), no sender phone. `auto_match_audit`: `match_method: name`, `phone_source: null`, `matched_phone_last9: null`, confidence 0.65 (medium).
- Two profiles share the name. `gmail-poll-transactions` (tie-break, ~lines 2166-2210) picked the more recently signed-in one: `dc676bca-…` (+256779166640), crediting 20,000 to **its float** (deposit `4fa90cec-…`, ledger group `3b656802-…`).
- The tenant's first 20,000 (TID 44056802806, 7 Oct) matched correctly and settled through `trg_tenant_self_repayment_on_approval` -> `settle_tenant_rent_from_deposit`.
- Not a phone-ordering bug: the phone-first path already exists, it just had no phone to use. (The `…2225` number on the receipt row appeared after the match; origin not established.)

State before the fix: wrong profile's wallet = exactly 20,000 float (untouched), tenant wallet 0, plan at 21,000 of 2,015,000.

## Change

One DO block, same deposit row kept (single TID, single Gmail link, one audit trail):

1. Guards: deposit/Gmail/ledger group match expectations, wrong profile's float still >= 20,000 (else refuse, a spent credit needs a human).
2. Reverse the wrong profile's ledger group (opposite `agent_float_deposit` legs, as the 44 historical float reversals did), reconcile its wallet.
3. Release the `general_ledger` TID claim the reversed credit left (the tenant's leg re-records it).
4. Park the deposit `pending`, re-point `user_id` to the tenant, `agent_id` NULL, note appended.
5. Post the tenant's float credit (same shape as the original).
6. Approve -> the existing trigger settles the plan, books the `tenant_deposit_auto` collection and agent commission, queues tenant + agent SMS.

Rolls back unless the attempt row is `settled` for exactly 20,000, `amount_repaid` rose by exactly 20,000 and both wallets' float ends at 0. Idempotent (returns when the deposit already belongs to the tenant). `deposit_bridge_events` is keyed on `deposit_request:<id>`, so re-approval does not double-enqueue.

Expected after: plan 41,000 paid; tenant SMS "Rent payment received"; the agent's dashboard shows the collection.

## Open

- **Matcher:** with 2+ same-name profiles and no phone evidence, the tie-break still guesses (medium/low confidence). Proposed: stop auto-crediting those and leave them for Financial Ops. Not done; it changes crediting policy.
- Other same-name receipts credited by `most-recent-active` may be misattached too. Not measured.
- Where `gmail_transactions.counterparty` got the tenant's phone after the match is unexplained.
