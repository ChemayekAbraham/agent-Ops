# 191 — Bank payouts were still being filed as merchant "own money"

**Date:** 2026-10-02 · **Scope:** `supabase/functions/approve-withdrawal/index.ts`, migration `20261002160000_close_float_funded_bank_payout_claims.sql`

## Problem
Immaculate Namulindwa's desk BAITA (`1a88b1b8…`) showed UGX 28,853,616 as her own money: 26
`merchant_out_of_pocket_advances` rows in `needs_review` (25 Sep – 2 Oct), every one a `bank_transfer`
payout. Merchant float funds bank payouts as well as MoMo (e.g. 28 Sep: UGX 83.8M of bank payouts,
UGX 77.95M covered by float; own cash 0 on every row since 25 Sep). The 26 rows are the slice float
did not cover at that moment, because float was credited late or outside the ledger (funding tracker:
UGX 157M confirmed, 597.7M still `suggested`). The company owes her nothing.

## Root cause
Doc 134 stopped `classify_merchant_payout_funding` raising claims for bank payouts from 2026-09-25,
but the **live writer** is the out-of-pocket block in `approve-withdrawal`, which files a
`needs_review` row at settlement for any float shortfall with no payout-method check.

## Fix
- `approve-withdrawal`: the out-of-pocket block skips `payout_method = 'bank_transfer'`. The
  `MERCHANT_CHAIN_SKIPPED` loud-failure check skips it too, so bank payouts don't raise a false gap.
- Migration: the 26 open rows are closed as `rejected` with a `FLOAT-FUNDED BANK PAYOUT 2026-10-02`
  review note (CFO instruction), like the 478 closed on 2026-09-25. Guarded to bank payouts in
  `needs_review`, never attested/reviewed/reimbursed.

## Not changed
- ~UGX 39.5k of small `pending_reimbursement` telecom rows on bank payouts (BAITA 28 rows, ~650k
  across 5 other desks) are untouched.
- `needs_review` for MTN/mobile-money payouts still files as before.
- `reviewed_by` is left NULL on the closed rows.
- The 58 `suggested` external funding rows (UGX 597.7M) still need Finance to confirm or reject.

## Deploy
Deploy `approve-withdrawal` (Lovable publish alone does not deploy edge functions). Apply the migration.

## Verify
`select count(*) from merchant_out_of_pocket_advances o join withdrawal_requests w on w.id=o.withdrawal_id
where w.payout_method='bank_transfer' and o.status='needs_review'` → 0, and stays 0 after the next bank payout.
