# 114 — `ledger_account_map` drift broke every withdrawable↔float reclass

**Fixed live 2026-09-23. Live outage, ~46 minutes, no funds moved (the balance assertion did its job).**

## What was reported

Josh sent a screenshot of the FinOps "Move money" tool (`FinOpsWalletMovePanel.tsx` →
`finops-wallet-move`) failing with:

> Move failed — LEDGER_ASSERTION_FAILED: the transaction legs do not net to zero
> (debits UGX 7,200,000, credits UGX 0, difference UGX 7,200,000). Nothing was written to the ledger.

## What was found

`system_events` (`event_type='ledger.unbalanced_group_rejected'`) showed 5 rejected attempts between
10:18:58 and 10:24:12 UTC today, all `finops-wallet-move:user_to_user`, all cross-bucket
(withdrawable↔float) moves. Every rejected group had both legs landing on the **same** side:
withdrawable→float moves priced as two debits, float→withdrawable moves as two credits.

`ledger_account_map` carries two dedicated categories for this, `bucket_reclass_in` /
`bucket_reclass_out`, specifically so the withdrawable leg (`L1`) and the float leg (`A2`) resolve to
opposite sides of the account map and the two-leg group nets to zero (see migration
`20260819120811_...sql`, which seeded them with the withdrawable/`L1` rows on `debit_when='cash_in'`
— deliberately the *opposite* convention from the generic wallet/`L1` fallback, which uses
`cash_out`).

`ledger_account_map.updated_at` showed both `withdrawable`/`L1` rows (`bucket_reclass_in` and
`bucket_reclass_out`) had been flipped to `debit_when='cash_out'` at the exact same timestamp,
**2026-09-23 09:58:11 UTC** — one edit, not organic drift, and not from any tracked migration (no
migration since 20260819 touches `ledger_account_map` for these rows). The `notes` column on both
rows still described the original, correct design ("...so the pair nets to zero"), confirming only
the value was changed, most likely by someone "correcting" it to match the generic L1 convention
without realizing the whole point of the dedicated reclass categories is to be asymmetric.

With both `L1` reclass rows on `cash_out` (matching the fallback), every withdrawable↔float move
became structurally unbalanceable — not just this one operator's attempt. Blast radius: every path
that posts `bucket_reclass_in`/`bucket_reclass_out` through `postBalancedLedgerGroup`:

- `finops-wallet-move` (user_to_user, cross-bucket)
- `admin-withdrawable-to-float`
- `admin-float-to-withdrawable`
- `agent-convert-withdrawable-to-float`

No ledger corruption occurred — `assertLedgerGroupBalanced` rejects unbalanced groups *before*
`create_ledger_transaction` is called, so every one of these attempts wrote nothing. The failure mode
was a full outage of cross-bucket money movement, not bad data.

## Fix

Restored `debit_when='cash_in'` on both `withdrawable`/`L1` rows for `bucket_reclass_in` and
`bucket_reclass_out`, matching their original 2026-08-19 seed values (and their still-correct
`notes`). Applied directly to production (`ledger_account_map` is config, not ledger/wallet data) at
10:44:43 UTC, and tracked in
`supabase/migrations/20260923110000_restore_bucket_reclass_withdrawable_debit_when.sql` as an
idempotent `WHERE debit_when = 'cash_out'` guard so re-running it is a no-op once correct.

## Open question

Who/what made the 09:58:11 edit is unknown — it wasn't a migration in this repo. Worth asking
whoever was touching `ledger_account_map` around that time (directly, or via an admin config screen
if one exists) before assuming it won't recur.
