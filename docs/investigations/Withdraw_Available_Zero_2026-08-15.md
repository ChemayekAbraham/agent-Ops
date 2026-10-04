# Withdrawal says "Available: UGX 0" while wallet shows funds — 2026-08-15

Affected user: GLORIA NAMATOVU (`7509cbc2-1614-4622-a9dc-07f75ebfc827`, +256750511507), requesting UGX 325,987.

## Diagnostic

```
DISPLAYED WALLET BALANCE            UGX 325,987
WITHDRAWAL AVAILABLE BALANCE        UGX 0        (client-side pre-check only)
LEDGER-DERIVED WITHDRAWABLE         UGX 325,987
  wallets.withdrawable_balance      UGX 325,987
  v_user_wallet_strict.withdrawable UGX 325,987   pending_holds 0, restricted 0
  get_user_wallet_view              UGX 325,987
  get_user_available_balance        UGX 325,987
  float / advance buckets           UGX 0 / UGX 0
  pending/stale withdrawal holds    none (last request 2026-08-04, completed)

SOURCE OF DISCREPANCY   Client-side helper converted a FAILED balance read into `available: 0`.
AFFECTED QUERY/FUNCTION src/lib/computeLedgerAvailable.ts (wrapping RPC get_user_wallet_view),
                        consumed by WithdrawFlow.refetchLedger() → step-5 pre-submit gate.
AFFECTED WALLET/BUCKET  withdrawable (correct bucket; no bucket mismatch, no float leakage)
ROOT CAUSE              On any RPC error (timeout / transient network / expired token) the helper
                        returned `{ available: 0 }` instead of throwing. WithdrawFlow then treated
                        that 0 as verified ledger truth, min()-ed it against the wallet figure and
                        raised "Insufficient funds. Available: UGX 0". The wallet card uses the same
                        RPC but throws on error and keeps its last good value — hence the contradiction.
                        Server truth was never 0; the server gate was never reached.
```

Ruled out: bucket mismatch, stale/orphaned holds, duplicate reservations, wrong user_id/wallet,
anchor windowing (anchor 2026-05-07, post-anchor net positive), ledger drift.

## Fix

- `computeLedgerAvailable` now **throws** on a failed read. It can never fabricate a zero balance.
- New `src/lib/withdrawAvailability.ts` holds the one authoritative definition:
  `available = max(0, withdrawable − holds)`; float and advance buckets are excluded by construction.
  `resolveWithdrawCap` treats `ledgerAvailable === null` as UNKNOWN → falls back to the figure the
  wallet UI shows and defers to the server gate; when known it takes the lesser of the two so a
  drifted cache can never inflate the cap.
- `WithdrawFlow` uses that helper for its cap and skips the client pre-check when verification failed,
  so `submit_withdrawal_request` (ledger-backed, idempotent, concurrency-safe) remains the only
  authority that can reject for funds. Validation is not bypassed: a genuine 0 still blocks.

No money moved, no ledger row, cache or classification touched.

## Regression tests

`src/__tests__/withdrawAvailability.test.ts` — 9 tests covering: normal withdrawal, insufficient
balance, float-only (never withdrawable), pending hold, released hold, wallet/withdrawal parity,
unknown-verification must not read as zero, cache-above-ledger clamp, genuine zero still blocks.
