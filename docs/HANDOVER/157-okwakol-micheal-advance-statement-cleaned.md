# 157 — Okwakol Micheal: advance statement cleaned to match the wallet

**Status: LIVE 2026-09-29.** Instructed by Joshua Wanda and carried out by Claude. Balance unchanged, no wallet or `general_ledger` change.

**Agent:** Okwakol Micheal, +256793487307, `75891dff-d684-49e9-83ea-fab6e4cb4ded`
**Advance:** `8977ca67-a3f4-41cd-ae32-df3999290b25`, issued 14 Jul. Principal 200,000 + access fee 66,000 + 10,000 fee = **276,000**.

## What was wrong (from the Wallet check, handover 154)

| Date | Problem | Cause |
|---|---|---|
| 19 Jul | balance +4,815 with no row | the 14 Jul deduction was taken on the Day-0 grace day and refunded to his wallet on 19 Jul ("Reversal of same-day advance sweep") |
| 22 Aug | balance −46,551 with no row | `advance_interest_removal` at 21 Aug 18:00 UTC (228,986 → 182,435) |
| 9 Sep | 214,433 "deduction" with no wallet debit | fake manual clearance (handover 137, entry 9) |
| 27 Sep | +0/−0 row raising the balance 0 → 214,433 | handover 139 reinstatement of that clearance |

## What was done (one transaction, guarded)

- Deleted the 9 Sep and 27 Sep rows. They net to 0. Their full JSON is in `audit_logs.agent_advance_statement_cleaned`.
- Added two `balance_adjustment` rows using the new `adjustment_amount` column (handover 156), each at the time of the real event and with a note: **+4,815** on 19 Jul and **−46,551** on 21 Aug.
- Recalculated every running balance from 276,000. The statement ends at **200,076**, equal to the advance's balance.

**Wallet check: reconciled, 0 issues.** 11 deductions = 11 wallet debits = 114,700. Total penalty added: 80,512. The handover-156 triggers raised no exceptions.

## Not touched
- Okwakol's completed May advance `1fb74a3d` (1,200,000). Its wallet and statement match (1,313,278), but it was marked `completed` on 29 Jul while the statement still ended at **316,581**. That's either forgiven debt or a status bug; it needs a CFO call.
- Deductions on 8977ca67 have been paused since 28 Sep 11:42 UTC (`advance_deduction_paused` by `99890a2e`).
- The second profile "Okwakol Micheal (Mande)" `b57c3fa6` has no advances.
