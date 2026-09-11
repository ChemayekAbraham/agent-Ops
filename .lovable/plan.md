# Rush-hour payout queue recovery — release remaining merchant claims

## Live state, just checked (16:35 UTC, 11 Sep 2026)

Only **2** open payouts are still held by a merchant. Both have **zero** evidence that money left: no processed time, no finance reference, no processing start, no proof file, no payout code, no transaction id, and neither is hidden from the queue.

| Requester | Amount (UGX) | Held by | Claimed | Evidence |
|---|---|---|---|---|
| JOSHUA WANDA | 100,000 | Emma Maiso | 15:54 UTC | none |
| LUKODDA JOSEPH | 1,000,300 | MULUNGI AIDAH | 15:15 UTC | none |

Shared pending queue right now: **14 payouts, UGX 9,484,140**. Held: **2, UGX 1,100,300**.

One caution to flag before acting: the MULUNGI AIDAH hold had its float set aside again at **16:18 UTC (about 17 minutes ago)**, which usually means the merchant is at the phone working on it. There is still no proof, code or transaction id, so by the rules given it qualifies for release — but it is the one row with any sign of recent activity.

## Action

1. Re-check both rows immediately before acting, and abort the release of any row that has picked up any evidence in the meantime.
2. For each row that is still clean, in one guarded statement per row:
   - release the merchant's set-aside float using the existing `release_merchant_float` routine with reason `rush_hour_admin_release` (history is kept — the reservation is marked released, never deleted),
   - clear only the merchant assignment on the withdrawal so it returns to the shared queue.
3. Nothing else changes: amount, requester, destination, status, wallets, ledger, settlement records, payout references and history are untouched.
4. The new one-claim-per-merchant protection and the 45-minute automatic release job are left exactly as they are.

## Verification and report

After acting, re-query and report: released count, total UGX returned, requester names and amounts, anything not released with the exact blocking evidence, remaining held count/amount, and the resulting shared queue count and total. Each released row will be confirmed to show open status, no processed time, no finance reference, not hidden, and no merchant assigned.

## Technical notes

- Release path: `public.release_merchant_float(p_withdrawal_id, p_reason)` per row (refuses if the reservation is already consumed), then `UPDATE public.withdrawal_requests SET assigned_cashout_agent_id = NULL` guarded by `id = <row>` plus the full zero-evidence predicate (`processed_at IS NULL AND fin_ops_reference IS NULL AND processing_started_at IS NULL AND coalesce(payout_proof,'')='' AND coalesce(payout_proof_path,'')='' AND coalesce(payout_code,'')='' AND coalesce(transaction_id,'')='' AND status IN (queue statuses)`), so the update is a no-op if anything changed.
- `release_stale_cashout_claims()` is not usable here: both rows are inside the 45-minute window.
- No migration, no schema change, no code change.
