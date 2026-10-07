# 200 — Bayo Mercy Money-at-Bank reset to 0 (cutoff moved to 2026-10-07)

**Migration `20261006180000_bayo_mercy_reconciliation_reset_2026_10_07.sql`. Logic only; no ledger rows. NOT YET APPLIED to production as of writing: verify the live function after it is pushed.**

## Why
`get_money_at_bank_reconciliation()` showed Bayo Mercy at about **-24.9M** (1,000,242,732 received
less 1,025,147,000 sent since the 2026-09-07 cutoff). Verified against `gmail_transactions` and
Gmail on 2026-10-06: no email was missed (no Welile -> BAYO MERCY transfer exists for 30 Sep / 1 Oct).
Mercy forwards to Catherine before Welile's top-up lands (1 Oct -37M, 2 Oct -11.1M, 5 Oct +17.3M,
6 Oct -16.3M). Josh ruled the balance a miscalculation: Welile funds each day's activity the
following day, there is no owed top-up, so the debt is removed.

## Change
Cutoff literal in the live function moved from `2026-09-07 00:00:00+03` to
`2026-10-07 00:00:00+03`, the same mechanism as the 7 Sep reset. The migration rewrites the live
body via `pg_get_functiondef` (the repo copy has drifted) and raises if the literal is absent.

## Consequences / watch
- Money at Bank reads 0 until new emails arrive after 7 Oct 00:00 EAT. Tomorrow's Welile top-up and
  Mercy sends net from 0. A top-up that covers 6 Oct sends would show as a credit.
- `get_merchant_agent_money_owed` reads this function, so `bayo_mercy_total` becomes 0. Merchant
  float (18,986,395 on 2026-10-06) still counts in Money We Owe: it is the withdrawable money users
  can claim, held by the desks.
- Known classifier leaks are unchanged (MTN/Airtel transfers to Mercy's phones are not counted; the
  function reads `channel = 'bank'` only).
- Undo by re-running with the old literal.
- Not drift-watched (`critical_function_baselines` has no row for it), so no re-baseline needed.
