# 240 - CFO "Cancel advance" button failed (trigger text = uuid); Sharifu Kalule advance cancelled and collections reallocated (2026-10-16)

**Status:** APPLIED LIVE 2026-10-16 and verified. Migrations `20261016100000` (trigger fix + cancel) and
`20261016120000` (reallocation) are in the repo to match. Drift baseline for the trigger NOT re-baselined yet.

## Finding
The CFO "Cancel advance" button did nothing. Cause: `tg_advance_balance_must_be_on_statement`
(added by `20260929160000_advance_statement_records_every_movement.sql`) looked up the audit reason with
`audit_logs.record_id = NEW.id`. `record_id` is text, `NEW.id` is uuid, so any balance change without a
matching statement row raised `42883: operator does not exist: text = uuid`. A write-off
(`cancel_agent_advance(..., p_recoup := false)`) zeroes the balance, so it always hit this and rolled back.
A CFO cancel command earlier the same day therefore never landed (no cancel audit row, no cancel fields).

## What was done
1. **Trigger fix** - `NEW.id::text`. The only change. Fixes the button for every advance.
2. **Cancel** advance `cef95679-bd3b-4b4a-88a0-bae32e39a1c5` (Sharifu Kalule, agent `98ee118b`, principal
   800,000) as `write_off` at 2026-10-16 08:30 UTC by Joshua Wanda. `pre_cancel_outstanding` = 901,909.20.
   Audit row `agent_advance_cancelled`; statement row -901,909.20 (plus the expected
   `unrecorded_balance_change` exception for it).
3. **Reallocation** of UGX 240,696.80 of wallet-backed deductions collected on the cancelled advance to her
   active advance `b94abec1-37b7-4eb0-8af5-200373aa140b` (2,958,423.04 -> 2,717,726.24). Statement-only: no
   wallet debit, no general_ledger posting (the cash was already collected; `cfo_record_advance_payment`
   would have double-counted). Audit row `advance_collections_reallocated`.

## Numbers on the cancelled advance (before the cancel)
- Ledger deductions: 806,714.80 over 102 rows (2026-08-15 to 2026-10-16).
- 506,936 of that is the two fake "manual payments" (253,468 on 08-27 and 09-01) reinstated 09-26. Excluded.
- Real: wallet-backed 240,696.80 (reallocated); 59,082 of small deductions with no wallet entry linked
  (mostly 09-27 to 09-29, plus 28,768 on 08-15) - NOT reallocated, unconfirmed.
- Nothing was deducted after the cancel.

## Open
- The reallocation raised a `deduction_without_wallet_debit` statement exception (240,696.80) on `b94abec1`.
  Accurate and by design; close it with a note pointing at the audit row.
- Re-baseline the drift detector for `tg_advance_balance_must_be_on_statement` (not done).
- The 59,082 unlinked deductions: confirm against the wallet, then reallocate or refund.
- Related account: KALULE SHARIF (`3f87c1f3`, sharifkc264@gmail.com) is a second account for the same
  person with the same National ID (spelled with an O instead of a zero). See the separate withdrawal
  block finding; the advance recovery only deducts from `98ee118b`'s wallet.

## Gotchas
- Any other write-off/cancel/zeroing of `agent_advances.outstanding_balance` hit the same trigger bug before
  this fix. If other advances show a failed cancel, retry now.
- A statement row must be inserted BEFORE the balance update (as `cfo_record_advance_payment` does), or the
  trigger adds its own `balance_adjustment` row and an exception.
