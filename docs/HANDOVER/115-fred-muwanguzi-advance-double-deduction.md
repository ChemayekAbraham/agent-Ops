# 115 — `finops-wallet-move` "repay an advance" corrections never touch `agent_advances`, causing a same-day double deduction

**Fixed live 2026-09-23 for one agent (FRED MUWANGUZI). The systemic gap in `finops-wallet-move` that
caused it is NOT fixed — any future manual correction tagged as an advance repayment through that
tool will hit the same bug.**

## What happened

Josh (CFO) reported: FRED MUWANGUZI (`9bb21b14-cf97-428d-960a-abdd244e80b8`) received a new
UGX 700,000 agent advance, the CFO deducted "400K+" from his wallet, and the remaining balance was
then deducted again — money that was supposed to stay in his wallet.

Traced in `general_ledger` for 2026-09-23:

| Time (UTC) | Event | Wallet impact |
|---|---|---|
| 10:47:38 | New advance disbursed (`agent_advances` id `1ad14342…`, principal 700,000, 30d @ 15%) | +700,000 |
| 10:55:59 | Manual `finops-wallet-move` error correction, ref `ECW-E53519D256`: "returned UGX 485,452 ... [Manual reconciliation] Repayment of Advance" | −485,452 |
| 12:01:28 | Automated daily advance-recovery run against the **old** advance (`19c74e2a…`, principal 1,000,000, issued 2026-08-13, was `overdue`) — accrued 4,011 penalty interest then deducted a day's installment | −215,318 |

The 485,452 the CFO pulled matches (to the shilling, modulo rounding) the old advance's outstanding
balance that morning (485,451.74) — clearly intended to settle it in full. But `finops-wallet-move`
(`supabase/functions/finops-wallet-move/index.ts`) only ever posts a wallet-cash leg + a platform leg
via `create_ledger_transaction`; it has no `advance_id` parameter and never touches `agent_advances`
at all. So `19c74e2a`'s `outstanding_balance` stayed at 485,451.74 in the database even though the
cash had already left the agent's wallet.

An hour later the recovery job ran on its normal schedule, saw that stale, un-reduced balance, and
collected a further day's installment against it — a real second deduction on a debt that had, in
effect, already been paid. Net: Fred's wallet lost 700,770 today against a true remaining debt of
485,451.74, nearly wiping out the new 700K advance he'd just received.

## Fix applied (Fred only)

1. Credited UGX 215,318 back to Fred's withdrawable wallet through the same sanctioned path
   `cfo-direct-credit` uses (`platform_wallet_corrections` evidence row, then
   `create_ledger_transaction`, category `wallet_transfer` / `system_balance_correction`, ref
   `PAY-CLAUDE-215318A`, ledger group `da596c80-cb21-4812-841a-b1d12d941b6e`) — not a raw balance
   edit.
2. Closed out the old advance (`19c74e2a-4112-41fd-ac7a-d13956cb9695`): `outstanding_balance` and
   `arrears_balance` → 0, `status` → `completed`, `access_fee_collected` → 280,000 (full),
   `access_fee_status` → `settled` — mirroring exactly what `cfo-record-advance-payment` computes for
   a fully-repaid advance, so tonight's recovery cron doesn't collect a third time.
3. `audit_logs` entry recorded (`cfo_advance_payment_recorded`) cross-referencing both reference ids.

No `agent_advance_ledger` row was inserted for the closure — `zz_guard_agent_advance_double_charge()`
correctly rejected a synthetic `amount_deducted` entry for the full 274,144.74 (today's already-charged
215,318 plus that would exceed the daily cap), which is exactly the protection that should have stopped
the real double-charge in the first place. The general ledger's existing `ECW-E53519D256` entry remains
the record of the actual cash movement; the advance row was corrected without fabricating a second one.

## What this doc does NOT establish / did NOT fix

- **`finops-wallet-move` still has no way to link an "advance repayment" correction to
  `agent_advances`.** Its `REASON_CODES` include `manual_reconciliation`, but nothing in the function
  reads or writes the `agent_advances` table — the free-text "Repayment of Advance" note is
  informational only. Any operator repeating exactly this move (manually clawing back a wallet balance
  and calling it an advance repayment) will reproduce the identical double deduction the next time the
  recovery cron runs, for any agent, on any advance.
- `cfo-record-advance-payment` (the tool that *does* update `agent_advances.outstanding_balance`) is
  not a safe substitute here without modification — it unconditionally posts its own wallet cash-out
  leg for the amount recorded, which would have charged Fred a **third** time had it been used after
  the cash already moved via `finops-wallet-move`. It's the right tool only when the cash hasn't moved
  yet.
- No code or migration change was made to close this gap. The real fix is either (a) give
  `finops-wallet-move` an optional `advance_id` that reduces `agent_advances.outstanding_balance` in
  the same transaction when a correction is tagged as an advance repayment, or (b) train operators to
  use `cfo-record-advance-payment` for advance repayments and reserve `finops-wallet-move` for
  everything else. Neither has been decided or built.

## What not to do

- Don't treat a `finops-wallet-move` "Repayment of Advance" correction as having actually reduced the
  advance's balance — check `agent_advances.outstanding_balance` directly before assuming a debt is
  settled.
- Don't re-run `cfo-record-advance-payment` to "properly record" a correction that already moved cash
  through `finops-wallet-move` — it will move the cash again.

## Verify this is still the state

```sql
select id, status, outstanding_balance, arrears_balance, access_fee_status
from agent_advances where id = '19c74e2a-4112-41fd-ac7a-d13956cb9695';

select created_at, amount, direction, category, description, reference_id
from general_ledger
where user_id = '9bb21b14-cf97-428d-960a-abdd244e80b8' and transaction_date >= '2026-09-23'
order by created_at;
```
