# 226 — Bank payouts file merchant own-money claims again (2026-10-14)

**Status: CODE ONLY. Neither piece is deployed/applied.** Deploy `approve-withdrawal`, then apply migration `20261014120000`.

## Decision
Josh, 2026-10-14: bank payouts must file claims like MoMo, on all desks. This reverses doc 134 (classifier, 2026-09-25) and doc 191 (edge writer, 2026-10-02), which treated uncovered bank payouts as treasury-funded. Chosen over "BAITA only" knowingly.

## Why two pieces
- `approve-withdrawal`: dropped the `bank_transfer` skip on the out-of-pocket filing block and on the `MERCHANT_CHAIN_SKIPPED` check.
- `classify_merchant_payout_funding` (live DB): its `v_treasury_bank` branch DELETED open `pending_reimbursement`/`needs_review` rows on bank payouts after 2026-09-25. Edge change alone would file rows the classifier then deletes. Migration neutralises `v_treasury_bank` via string replace on the live definition (fails if the marker is not found exactly once; verified once, not in `critical_function_baselines`).

## Expect
- BAITA (Immaculate, `1a88b1b8`) will refill with `needs_review` rows when float is 0 — the Sept pattern (UGX 488.5M closed 09-25, 28.9M closed 10-02). They are not owed until reviewed/attested; "under review" totals will rise.
- Bank fee on these claims uses the wallet-to-bank tariff (doc 225).
- Forward only: closed/rejected rows are not reopened; no backfill.

## Verify
After the next bank payout with no float: a `merchant_out_of_pocket_advances` row (kind payout + telecom) exists for its withdrawal and survives `classify_merchant_payout_funding`.
