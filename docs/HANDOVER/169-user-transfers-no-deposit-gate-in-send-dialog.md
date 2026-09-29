# 169 — User-to-user transfers: no deposit gate in the Send Money dialog

**Written 2026-09-30. Frontend only. Not yet deployed.**

## Instruction
CEO: any user should be able to transfer any amount they hold, not subject to how much they have deposited.

## What was found
- `wallet-transfer` (edge function): deposit-history gate already removed 2026-09-29. The balance check on `get_user_available_balance` is the only money gate.
- `get_user_available_balance` (live body verified): reads `wallet_balances_projection.withdrawable`, minus funder pending hold and, only when `advance_withdrawals_paused` is on, the advance-locked portion. No deposit logic.
- `check_transfer_recipient_eligibility` (live body verified): receiver checks only.
- `src/components/wallet/SendMoneyDialog.tsx`: still counted `deposit_requests` with `status = 'approved'` and locked Send until 7. A user who earned commissions or returns and never deposited saw "Sending to other users is locked".

## Change
`SendMoneyDialog.tsx` only: removed the approved-deposit count query, the `transferLocked` flag, its disabled-reason line and its "locked" banner. The perf-gate banner condition no longer depends on the removed flag. The remaining money gate is `amount <= wallet.withdrawable`, mirrored by the server.

## Not changed / open
- The dialog still locks agents whose collection today is under 20% (`perfLocked`). The server removed that gate for transfers on 2026-09-29, so screen and server disagree. Left for a decision.
- `FinOpsWalletMovePanel.tsx` still warns when an admin move equals a user's lifetime deposits. That is a staff tool, not the user flow.
- Two now-unused declarations remain at the top of the dialog (`approvedDepositCount` state and `MIN_APPROVED_DEPOSITS`). Harmless; delete on the next pass.
- Not type-checked locally (tsc cannot complete on this machine).

## Rollback
Revert this commit. The server never enforced the 7-deposit rule after 2026-09-29, so restoring the screen gate only affects the UI.
