# 230 — Settlement RPC accepts zero-float payout claims (2026-10-14)

**Status: APPLIED BY HAND 2026-10-14 (Josh); migration file written to match.**
Migration: `supabase/migrations/20261014210000_settle_oop_accepts_zero_float_claims.sql`

## Problem
`settle_merchant_out_of_pocket` re-derives evidence in its own loop (a third copy
of the rule, after the view and the overview RPC). It still required float
position `< 0`, so Immaculate's zero-float claims (docs 228/229) would have been
skipped as `not_evidenced_by_books` when finance tried to settle.

## Change
Marker replace on the live definition: `is_evidenced` uses `<= 0`, and
`v_evidenced_amount` gets `WHEN position = 0 THEN shortfall_amount` before the
existing capped `ELSE`. Estimated telecom claims are still skipped.

## Verified live
Function contains the doc 230 marker, old `< 0;` test gone, zero branch and the
original ELSE both present. Not exercised by a real settlement.

## Not changed
- Settlement itself: finance must run it; nothing was paid. No credit had reached
  Immaculate's wallet and no reimbursement existed at the time of the check.
- A float top-up is not a reimbursement and does not reduce the owed figure.
- Mercy Bayo 7,214,190 and Prossy 5,259,963 stay unsettleable (positive float at
  payout).
- Three copies of the rule now exist (view, overview RPC, this RPC); change all
  together in future.
