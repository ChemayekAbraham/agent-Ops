# Merchant payout telecom-charge atomicity fix (2026-09-12)

**Read this when:** a merchant cash-out's float debit looks wrong — principal posted but no telecom
fee, or the telecom fee looks proportionally guessed instead of a real ledger leg — or before
changing `ensure_merchant_payout_float_debit`, `classify_merchant_payout_funding`, or
`sweep_merchant_payout_float_debits`.

## The problem

`ensure_merchant_payout_float_debit()` in production was still the pre-2026-08-30 principal-only
version: it debited `LEAST(available_float, withdrawal_amount)` and called
`consume_merchant_float(..., consumed_telecom => 0, ...)` unconditionally. An earlier migration
(`20260911180000`) meant to fix this existed in the repo but had **never actually applied to the
live database** — `supabase/migrations/` diverging from what's actually deployed is a known,
recurring failure mode here (see the main README's "Known documentation drift" section and
`CLAUDE.md`'s "Known gotchas"). Always verify a function's live definition with
`pg_get_functiondef` before trusting a migration file.

Concretely: a UGX 1,500,000 merchant payout had a reservation recording `consumed_telecom = 2,000`,
but `general_ledger` had only the principal `-merchant-float-consume` leg — no
`-merchant-telecom-charge` leg existed at all. This was not a one-off; every merchant payout going
through the DB guard lost its telecom fee the same way.

The old guard also had a single up-front gate ("does ANY float leg already exist for this
withdrawal? if so, skip entirely") — meaning a principal-only debit (float ran out exactly between
principal and telecom, or the shared idempotency key got pre-empted) **permanently blocked the
telecom leg from ever posting**, either from the guard itself or from the finance repair sweep,
since the sweep's candidate query also excluded any row with any float leg present at all.

## The fix (`20260912130000_merchant_telecom_leg_independent_idempotency.sql`)

Three functions had to move together, in one migration:

1. **`ensure_merchant_payout_float_debit(p_withdrawal_id)`** — principal and telecom are now
   checked as two **independent** legs, matched by their own `reference_id`
   (`<withdrawal_id>-merchant-float-consume` / `<withdrawal_id>-merchant-telecom-charge`), not one
   shared "any debit exists" gate.
   - If **neither** leg exists: debit principal first, remainder to telecom, from one pool —
     the same allocation `approve-withdrawal` itself uses.
   - If **principal is posted but telecom is missing**: backfill **only** the telecom leg, under
     its own dedicated idempotency key `approve-withdrawal-merchant-telecom-charge-<id>` — the
     same key `approve-withdrawal`'s own read-back/catch-up posts under, so whichever writer gets
     there first, the other is a safe no-op. **Principal is never re-touched once posted.**
2. **`sweep_merchant_payout_float_debits(p_days, p_dry_run)`** (the finance-invoked repair sweep,
   role-gated to CFO/financial_ops/manager/super_admin) — same independent-leg detection, so it can
   actually find and offer to fix a principal-only row going forward. Bounded by the same cutoff as
   #3 below, so it can never reach into the pre-existing historical backlog.
3. **`classify_merchant_payout_funding(p_withdrawal_id, p_via)`** — reads the real
   `-merchant-telecom-charge` ledger leg for any payout processed **at or after the cutoff**
   (`2026-09-12 03:50:00+00` — see "The cutoff bug" below), instead of proportionally guessing
   telecom's float coverage from the principal's coverage ratio. Payouts processed **before** the
   cutoff keep the exact same proportional approximation they always got — **no reclassification
   of history, no new receivables raised retroactively.** This mirrors the "no backfill" decision
   Finance already made for the same class of historical gap (`20260911180000`).

Nothing in this fix touches any already-posted ledger row. The sweep's candidate query and
classify's real-leg read are both bounded by the same cutoff, so neither can reach into the
pre-existing backlog of historical principal-only payouts.

## The cutoff bug (`20260912140000_fix_telecom_cutoff_timestamp.sql`)

The first migration hardcoded the cutoff as `2026-09-12 13:00:00+00`, assuming a later same-day
deploy. The actual deploy happened at `03:53 UTC` that day. This was caught via a dry run that
returned an unexplained zero (no payouts classified as "new-style" even though the fix had clearly
gone live) — not by inspection. Fixed with a same-day follow-up migration setting the cutoff to
`2026-09-12 03:50:00+00`, applied to both `classify_merchant_payout_funding` and
`sweep_merchant_payout_float_debits` (they must always share the same cutoff value — a mismatch
between them would make the sweep offer to "fix" a payout that classify still treats as
pre-cutoff/legacy, or vice versa).

**Live-verified 2026-09-14**: both functions' current bodies contain the corrected
`03:50:00` cutoff.

## If you touch this again

- Check `pg_get_functiondef` for all three functions before assuming the migration files reflect
  what's live — this whole incident happened because they didn't.
- Never change the cutoff on one of `classify_merchant_payout_funding` /
  `sweep_merchant_payout_float_debits` without changing it identically on the other.
- Do not backfill telecom legs for payouts before the cutoff. Finance has already decided that
  historical principal-only payouts keep their proportional approximation, not a reclassification.
- `merchant_telecom_sending_charge(amount)` (used by the guard) and `telecom_sending_charge(amount)`
  (used by classify) are two separate functions — confirm they still agree on the fee formula if
  you change either.
