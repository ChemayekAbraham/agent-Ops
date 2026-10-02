# 192 — Bayo Mercy's three unevidenced "own money" claims closed

**Date:** 2026-10-02 · **Scope:** migration `20261002170000_close_bayo_mercy_unevidenced_claims.sql` (data only)

## Problem
The merchant settlement-debts view (`useMerchantSettlementDebts`) showed UGX 38,403,576 as payable to
agents. UGX 38,141,536 of it was three Bayo Mercy `pending_reimbursement` claims:

| Advance id | Paid (UTC) | Recipient | UGX |
|---|---|---|---|
| `e3e3b55d-7c18-48b1-bf83-77f158ccf73b` | 2026-09-30 14:33 | Mercy Bayo (Airtel) | 28,430,000 |
| `e9c68947-826f-4e14-8573-fc05874b10ab` | 2026-09-30 14:39 | Mercy Bayo (Airtel) | 1,098,000 |
| `21925578-db55-4a1f-8ebe-70e089377a58` | 2026-10-01 09:15 | Aleete Lilian (Airtel) | 8,613,536 |

## Why there was no proof
Filed by `classify_merchant_payout_funding` ("Phase 6 classification: company float covered UGX 0…").
`evidence = {}`, never attested, never reviewed, no payout TID. They read as "evidenced" only because
`merchant_float_position_at` for Mercy was −42.44M — our own float ledger, which says nothing about
whether she used her own cash. Her float is netted by hand and funded outside the ledger (Mercy
settlement 2026-10-01; CFO ruled the company owes her 8,291,600 for that day, unchanged here).
`get_merchant_out_of_pocket_summary` already reported `owed_to_agent = 0`.

## Fix
Migration closes the three by exact id as `rejected` (`NO PROOF OF OWN MONEY 2026-10-02` note, CFO
instruction), only while still never attested/reviewed/reimbursed.

## Not changed
- The classifier still files `pending_reimbursement` claims on a negative float position alone. Same
  failure mode will recur on any desk with a negative float; a follow-up should require attestation or a
  payout TID before a claim becomes payable. Not done here.
- Remaining payable ≈ UGX 262k of small telecom-fee claims on other desks, untouched.
- The 8,291,600 Mercy settlement figure is separate and untouched.

## Verify
After applying: settlement-debts payable total ≈ 262k, Bayo Mercy payout-kind claims in
`pending_reimbursement` = 0.
