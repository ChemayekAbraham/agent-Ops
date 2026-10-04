# Phase Four — Pay out self-managed partner returns

Confirmed: returns are recognised on each commitment's own anchor date (contribution date + 1 month), so a partner who funds on the 3rd earns on the 3rd of every month. What is missing is the last step — recognised returns currently sit as `pending` payout cycles and never reach the wallet, and self-managed commitments do not appear in the COO "nearing payout" list (that list reads `investor_portfolios.next_roi_date` only).

## What gets built

1. **Payout engine (server-side)**
   - New edge function `process-partner-self-payouts` sweeps `partner_self_payout_cycles` with `status = 'pending'` whose `cycle_end` has arrived.
   - Per cycle: post one balanced ledger pair — platform `cash_out` / `roi_expense` and partner wallet `cash_in` / `roi_wallet_credit`, `recipient_type: 'user'`, `wallet_bucket: 'withdrawable'` — mirroring `process-supporter-roi` exactly, so wallet buckets and routing rules stay untouched.
   - Managed-proxy naming honoured via `resolveManagedProxy` (credit still lands in the partner's own wallet).
   - Mark cycle `paid`, stamp its earnings `paid` + `paid_at`, bump `partner_self_commitments.total_paid` and roll `next_payout_at` forward one month from the anchor.
   - Idempotent: a cycle already `paid` (or already carrying a `ledger_group_id`) is skipped, so re-runs cannot double-credit.
   - Advance recovery: run `apply_roi_advance_recovery` on the credited amount, same as managed ROI.
   - SMS/system event: emit a `system_event` for the payout so it contributes to trust signals.

2. **Daily cron**
   - `partner-self-payouts-daily` at `25 1 * * *` (just after the 01:10 accrual) so a cycle recognised in the morning sweep is paid in the same night's cycle.

3. **Nearing payout list (COO / Partner Ops)**
   - Extend the "nearing payout" panel to union self-managed commitments due within 7 days, sourced from `partner_self_commitments.next_payout_at` (status `active`), with the expected amount from the pending cycle / principal × rate.
   - Rows tagged `Self-managed` vs `Managed` so the COO can tell them apart; the existing PDF export picks up the same unified list.

4. **Partner-facing card**
   - `SelfPortfolioFundingCard` gains an earnings block: next payout date, expected amount this cycle, and paid-to-date, with a "returns pay on the {day} of each month" line so the anchor-date rule is explicit.

## Technical notes

- Tables in play: `partner_self_commitments`, `partner_self_funding_lines`, `partner_self_earnings`, `partner_self_payout_cycles`.
- Ledger categories restricted to the existing allowlist (`roi_expense`, `roi_wallet_credit`); `entries` passed as a raw array to `create_ledger_transaction`.
- No wallet field is written directly — `apply_wallet_movement` via ledger triggers remains the sole writer.
- Verification: rehearsal inside a rolled-back transaction (accrue → pay → replay) proving one credit per cycle, balanced legs, and correct withdrawable delta via `v_user_wallet_strict`.
