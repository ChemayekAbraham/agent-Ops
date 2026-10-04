# Merchant Agent Payout Settlement — Root Cause & Fix

## What is actually broken

The chain (Claim → Approve → Float debit → Telecom charge → Out-of-pocket receivable → 0.5% commission → Mark paid → Welile SMS) is **not broken for most merchants**. Live check of the last 2 hours: MULUNGI AIDAH 4/4 settled correctly, **Bayo Mercy 2 payouts (UGX 75,700) with no float debit and no commission** — same failure, happening right now. The same pattern over the wider history:

| Merchant | Settled | Float debited + commission | Missing |
|---|---|---|---|
| Tugabirwe Apophia, Catherine Nabaggala, Sky Bubbles, NAMULINDWA IMMECULATE, MBABAZI ROBERT, MULUNGI AIDAH, NABBALE CLAIRE, Mercy Bayo, Benjamin Muhanguzi | 100% | 100% | none |
| Mudumba samuel | 203 | 202 | 1 (UGX 650,000) |
| Hilary Evanz | 116 | 115 | 1 (UGX 2,088,320) |
| Nankambo sharimah | 74 | 53 | 21 (UGX 21,329,229) |
| Bayo Mercy | 19 | 4 | 15 (UGX 11,377,936) |

Total: **38 payouts, UGX 35.4M** settled with **no float debit, no telecom charge, no out-of-pocket receivable, no commission and no Welile SMS**.

**No backfill on these historical rows.** They are already paid out and the merchants are actively processing withdrawals right now — posting retro float debits, receivables or commissions would disorganise their live float position. They will simply be **settled out**: marked closed/reconciled-as-is with a note, and excluded from the merchant float and out-of-pocket calculations. Only payouts settled **after** the fix goes live get the full chain.

## Root cause (confirmed)

Merchant compensation is gated on a single client-sent flag `acting_as_merchant`. Only the merchant queue UIs send it (`AgentCashPayoutsTab`, `MerchantReconcilePaymentCard`). The FinOps/staff desk UIs (`WithdrawalPayoutCard`, `ApprovalQueue`, `FinOpsWithdrawalVerification`, `ReceiptCodeEntry`, proxy partner tools) never send it.

The two agents with mass failures are exactly the two who **also hold staff roles**:
- Bayo Mercy — manager, employee, operations, hr, tenant_ops, landlord_ops, agent_ops, partner_ops
- Nankambo sharimah — manager, coo, employee, operations, financial_ops

They front their own MoMo cash but close the payout from a staff desk. Without the flag every merchant block in `approve-withdrawal` is skipped: float stays untouched (Bayo Mercy's float shows UGX 1,500 after paying out UGX 11.4M), no commission is credited, and the merchant SMS is suppressed. The clean-record merchants only ever use the merchant queue, which is why they are unaffected.

Secondary finding: 4 of the 38 (UGX 2.8M) are also missing the **customer wallet debit** entirely — they were flipped to `paid` by the SMS-match trigger `trg_finalize_withdrawal_from_matched_payout_sms` without any ledger settlement running.

## The fix

### 1. Make merchant identity server-authoritative (stops all recurrence)
In `supabase/functions/approve-withdrawal/index.ts`, invert the flag's meaning: an **active `cashout_agents` row + a human (non-system) call = the merchant**, whichever desk was used. The flag becomes an opt-out only (`acting_as_merchant: false` or `staff_desk: true`) for a desk paying on someone else's behalf; system/bulk calls stay excluded as today. Staff roles never suppress compensation again.

### 2. Keep the proof-of-payment gate workable
The proof gate currently fires whenever `actingAsMerchant` is true. Since staff-desk settlements will now qualify, accept the proof those desks already lodge (`payout_proof_path` / existing proof on the request row) and hard-block only when no proof exists anywhere — so no desk is locked out by the change.

### 3. Fail loudly instead of silently
Log a `settlement_reconciliation_ledger` gap whenever a merchant settlement completes with zero float debit **and** zero out-of-pocket record, so a skipped chain surfaces the same day instead of weeks later.

### 4. Repair the 38 affected payouts
A one-time backfill RPC posting, per withdrawal, idempotently (reusing the exact `<id>-merchant-float-consume` / `-cashout-commission` references so nothing double-posts):
- float debit capped at the float actually available,
- out-of-pocket receivable in `merchant_out_of_pocket_advances` for the fronted remainder,
- 0.5% commission credit to withdrawable,
- and for the 4 rows missing the customer debit, the missing wallet withdrawal legs.

Because most of the UGX 35.4M was fronted from the agents' own MoMo lines, the repair mostly creates **company receivables** rather than float debits. I will produce the per-record schedule for your sign-off before posting anything.

### 5. Verify with a live transaction
After deploying, settle one real merchant payout end to end and confirm: float reduced, telecom charge posted, commission credited, SMS log row created, and the row gone from `v_merchant_payout_queue`.

## Technical notes
- Files touched: `supabase/functions/approve-withdrawal/index.ts` (flag logic, proof gate, gap logging); new migration for the backfill RPC.
- No change to `trg_enforce_settled_withdrawal_terminal` or `v_merchant_payout_queue` — queue removal already works.
- Order: ship (1)–(3), verify with a live payout, then run the repair in (4) once you approve the schedule.