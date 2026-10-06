# 199 — Advance-withdrawal lock blocked earned commission (Joel Kayongo)

**BUILT 2026-10-06, migration `20261006170000` NOT applied.** Nothing in production changed.

## Symptom
Joel Kayongo (`78f51f69-a075-480f-901d-b6cce23ad1fb`, +256705055041) has
withdrawable 34,762 (commission) but the app shows Available UGX 0.

## Cause (verified live)
`get_user_available_balance` = withdrawable − `funder_pending_hold` − (while
`treasury_controls.advance_withdrawals_paused` is on) `get_advance_locked_withdrawable`.
The lock = advance credits − every wallet cash_out since the first credit.
His credit is 165,000, `wallet_bucket='advance_credit'`, which the projection holds as
`advance_balance` (165,000), **not** in `withdrawable`. So the lock took 47,426
(165,000 − 117,574 outflows) out of a balance that never contained the advance.

Credit buckets: 558 legacy credits (523 users, to 2026-09-29) landed in `withdrawable`
(lock correct); 7,923 credits (299 users, since 2026-08-26) landed in `advance_credit`
(lock wrong).

## Fix
The lock now sums only credits with `wallet_bucket = 'withdrawable'`. Legacy behaviour
unchanged. Not in `critical_function_baselines`, so no re-baseline.

## Impact simulated before building
529 users have advance credits; the lock value changes for 211, but only 5 users gain
spendable money, UGX 72,258 in total (Joel's 34,762 is most of it). The rest were at
zero withdrawable anyway.

## Open
- The lock still counts ALL cash_outs (incl. float spent for rent, his own float
  deposits) against legacy credits. Left as is; separate question.
- Reported figures differed: 68,000 spent / 97,000 held (report) vs 117,574 / 47,426 (live).
  The live function is the source of truth; ask the reporter where 68,000 came from.
- Apply via migration, then check `get_user_available_balance` for Joel = 34,762.
