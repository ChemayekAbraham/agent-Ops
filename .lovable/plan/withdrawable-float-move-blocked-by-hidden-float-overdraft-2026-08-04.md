# Withdrawable → Float move blocked by hidden float overdraft

## Executive summary

The move never reaches the ledger. It is rejected by a pre-check inside the
`admin-withdrawable-to-float` backend function, which computes the user's float
position directly from raw ledger legs and finds it negative (UGX -544,600 for
Nabateregga Brenda — confirmed by query). The function only proceeds when the caller
sends `acknowledge_float_overdraft=true`.

The Move Money screen does have that acknowledgement checkbox, but it only renders
when `source.float_balance < 0`. The `wallets` view can never return a negative
bucket (it reads `wallet_balances_projection`, which reports Brenda's float as
+8,000). So the checkbox never appears, the flag is never sent, and every affected
move fails with no way for the operator to continue. That is the defect: an
unreachable escape hatch, not a financial-integrity block.

Read-only checks only; nothing was modified.

## Evidence

- Rejection point: overdraft pre-check in `admin-withdrawable-to-float` (HTTP 409,
  `code: "FLOAT_OVERDRAWN"`). No SQL error, no trigger, no ledger write attempted.
- Two balance sources disagree:
  - `wallets` / `wallet_balances_projection`: withdrawable 10,128 · float 8,000
  - raw wallet-scope legs with `wallet_bucket='float'`: net **-544,600** across 103 legs
- The helper the function prefers, `compute_wallet_float_net`, does not exist in the
  database, so it silently falls back to its own inline ledger sum — the stricter number.
- Blast radius: **138 users** currently have a negative raw float net (total
  UGX 359,121,105) out of 192 users with any float legs. Every one of them hits the
  same dead end on Withdrawable → Float. Float → Withdrawable, User → User and
  Recover to Platform have no such gate.
- Note: the screenshot shows Withdrawable 110,128 while the wallet now reads 10,128 —
  the on-screen figure was stale, or came from the duplicate profile with the same
  name (two "Nabateregga Brenda" profiles exist; the funded one is the one above).

## Financial integrity

Allowing the move is balanced. The function posts two wallet-scope legs of equal
amount (withdrawable cash_out / float cash_in), so no money is created or destroyed
and double-entry holds. With acknowledgement it additionally posts a balanced
`admin_correction` pair (wallet float cash_in / platform cash_out) that absorbs the
historical hole so visible float rises by the full amount.

## Fix (to implement on approval)

1. Frontend only — `src/components/financial-ops/FinOpsWalletMovePanel.tsx`:
   - Fetch the true float net for the selected user (raw wallet-scope float legs, same
     rule the backend uses) when direction is Withdrawable → Float.
   - Drive the existing overdraft warning + acknowledgement checkbox off that value
     instead of `source.float_balance < 0`.
   - Show the honest predicted float ("visible Float stays 0 unless the overdraft is
     auto-filled") instead of the current `float_balance + amount`.
   - If the backend still returns `FLOAT_OVERDRAWN`, surface the returned shortfall
     inline and reveal the checkbox so the operator can retry in one step.
2. No database, RPC, trigger, edge-function or balance changes. No historical data
   touched. Wallet balances change only when an operator confirms a move.

Risk: low — presentation and request-flag wiring only. The backend keeps the
double-entry and audit guarantees it already enforces.

Optional follow-up (not included): create the missing `compute_wallet_float_net`
helper so frontend and backend share one definition of float net, and reconcile the
projection vs raw-ledger divergence for the 138 overdrawn users.