---
name: Merchant telecom sending charge posted to float
description: Every merchant cash-out settlement posts a second ledger tx debiting the merchant's float bucket by the tiered MTN/Airtel sending fee so Welile float matches the merchant's MoMo statement
type: feature
---
Every merchant (cashout) settlement in `approve-withdrawal` posts TWO float debits, not one:

1. **Principal** — full payout `amount`, category `agent_float_settlement`, reference `<withdrawal_id>-merchant-float-consume`.
2. **Telecom charge** — `getTelecomSendingCharge(amount)` from `src/lib/cashoutCharges.ts` (100 / 500 / 1,000 / 1,500 / 2,000 UGX tiers), category `agent_float_settlement`, reference `<withdrawal_id>-merchant-telecom-charge`, idempotency key `approve-withdrawal-merchant-telecom-charge-<withdrawal_id>`. Only posts if the principal consume succeeded and the charge > 0.

Reconciliation invariant: **Merchant Float Allocated = Customer Payouts + Telecom Charges + Remaining Float**. The float-sufficiency gate now requires `amount + telecom_charge` before claiming — CFO/treasury must top up to cover both. Forward-only (2026-07-16); NO historical backfill.

`generate_merchant_cashout_daily_report` RPC + `merchant-cashout-daily-report` email now expose `total_telecom` and `total_float_consumed` (both aggregate + per-merchant + per-payout). `approve-withdrawal` response includes `merchant_telecom_charge` and `merchant_float_total_debit`.