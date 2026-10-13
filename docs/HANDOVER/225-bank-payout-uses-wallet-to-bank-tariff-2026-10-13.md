# 225 — Bank payouts now use the wallet-to-bank tariff (2026-10-13)

**Status: CODE ONLY, not deployed.** `approve-withdrawal` must be deployed via Lovable.

## Problem
Merchant agents pay Rent Plan / cash-out claims to bank from their mobile-money wallet. The phone's float ran out faster than Welile's float because `getTelecomSendingCharge` applied the mobile-money person-to-person tiers (100 / 500 / 1,000 / 1,500 / 2,000) to **every** payout, including `bank_transfer`. The telecom actually charges the wallet-to-bank schedule (minimum 1,500).

Measured on production, last 30 days: 571 bank payouts, UGX 906.5M principal. Fee posted to the ledger UGX 448,000; the MTN bank schedule gives about UGX 3.37M (estimate, MTN schedule applied to all).

## Change
- `supabase/functions/approve-withdrawal/index.ts`: added `BANK_CHARGE_TIERS`; `getTelecomSendingCharge(amount, payoutMethod)` uses it when `payout_method = bank_transfer`. The call site passes `wrPayoutMethod`.
- `src/lib/cashoutCharges.ts`: same table and an optional second argument. Existing display callers pass no method and are unchanged (they still show the P2P fee) — UI call sites should pass `payout_method` (Gemini's lane).

| Amount (UGX) | Charge |
|---|---|
| up to 125,000 | 1,500 |
| 125,001–250,000 | 2,250 |
| 250,001–500,000 | 4,100 |
| 500,001–1,000,000 | 6,150 |
| 1,000,001–2,000,000 | 9,250 |
| 2,000,001–5,000,000 | 11,300 |

## Caveats
- MTN schedule used. Airtel is cheaper under UGX 60,000 (700 / 880 / 1,210 / 1,500) and its table comes from an undated bank notice. Confirm with Airtel before adding a per-network split.
- New payouts only. Past bank payouts keep their old fee; **no backfill** (same rule as the repaying gate).
- Bank payouts still never file an out-of-pocket claim for a shortfall (doc 191, line `wrPayoutMethod !== "bank_transfer"`). Unchanged.
- Per the atomic-debit rule, the larger fee is debited with the principal as one transaction.
- Verify a few bank payouts against `gmail_transactions` after deploy to confirm the real fee deducted.
