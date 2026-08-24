---
name: Landlord rent-payment receipt + SMS
description: Permanent immutable receipt per completed landlord float disbursement, public /r/<10-char code> page, idempotent SMS from both merchant and FinOps completion paths
type: feature
---
Trigger: the landlord float payout is CONFIRMED — i.e. `landlord_payouts.status` becomes `awaiting_agent_receipt`/`completed` with `disbursed_at`/`finops_disbursed_at` set. Two call sites, both invoking the same edge function:
- Merchant agent path: `approve-withdrawal` `isLandlordFloatPayout` branch (replaced the old bare `sms-otp` landlord SMS).
- FinOps path: `LandlordPayoutsQueue.handleMarkDisbursed`.

Never issues a receipt while pending/failed (`issue_landlord_payout_receipt` returns `payout_not_confirmed`).

**DB**: `landlord_payout_receipts` (UNIQUE `payout_id` → idempotent, `receipt_code` = 10-char unguessable code from `generate_landlord_receipt_code()` (UUID-sourced, pgcrypto is NOT on search_path), `receipt_number` = `WLR-<seq>`, frozen `snapshot` jsonb, status completed|reversed|refunded, sms bookkeeping). `trg_guard_landlord_receipt_immutable` blocks edits to payout_id/code/number/amount/snapshot/generated_at/landlord_id/tenant_id — corrections require a reversal or replacement row. `landlord_payouts.landlord_id` points at `public.landlords` (NOT profiles) — read names from there.

**RPCs**: `issue_landlord_payout_receipt(payout_id, processed_by)` (definer, authenticated+service_role), `get_landlord_payout_receipt(code)` (definer, anon-granted, display-safe fields only), `record_landlord_receipt_sms(receipt_id, ok, error)`.

**Edge fn** `landlord-rent-receipt`: issues receipt → SMS via `sendSmsMultiProvider` once (`resend: true` for staff resend) → records delivery. SMS failure never affects the payout.

**Frontend**: `src/pages/LandlordRentReceipt.tsx` (public, no auth, print-clean, QR + PDF via `src/lib/landlordReceiptPdf.ts`), dispatched from `ResolveRLink` (`/r/:code`: short link → landlord receipt → payout receipt). `LandlordPaymentCompletedDialog` is the internal completion screen (view/copy link, resend SMS, return).

Link format: `https://welileapp.com/r/<receipt_code>`.
