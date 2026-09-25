# 134: Immaculate's bank desk "out-of-pocket" was treasury-funded, not owed

**Rectified and applied live 2026-09-25. Instructed by the CEO.** Read this before quoting any
figure for money "owed" to a merchant desk that pays by bank transfer, and before touching
`classify_merchant_payout_funding`.

## The two accounts

| | Account A | Account B |
|---|---|---|
| Profile | NAMULINDWA IMMECULATE `27d5a08b-5fee-452e-bc9a-bc8064f96ae3` | IMMACULATE NAMULINDWA `1a88b1b8-6601-477b-b119-8e18d5dc9ebd` |
| Desk | "Merchant Agent", float phone 0741003567 | **BAITA**, float phone 0762952753, bank: Equity, SKYBUBBLES TRADING AND INVESTMENT LIMITED |
| September activity | none (0 payouts) | 348 payouts, **344 of them bank transfers**, ~UGX 607M |
| Open claims before | none (all Aug rows closed by the 08-31 fresh start) | **478 pending, UGX 488,852,478** |

Account A needed nothing. Account B is the one that carries out bank payments.

## What was wrong

`classify_merchant_payout_funding` treats every UGX of a payout not covered by desk float as money
the merchant "fronted from their own phone" and raises a `pending_reimbursement` claim. Desk B's
float was repeatedly set back to 0 by corrections (08-26, 09-02, 09-08, 09-12, 09-22), and its
bank payouts are funded outside the ledger. So every bank payout from 2 to 24 Sep became a claim for
almost its full amount: 239 payout claims (UGX 488,514,534, float used only UGX 11.2M) and 239
matching telecom claims (UGX 337,944). None were attested or reviewed.

The funding trail for September, from the Equity and MTN emails in `gmail_transactions`:
- WELILE Equity …5259 → Bayo Mercy Equity …7542: 13 transfers, **UGX 497.0M**.
- Of that, …7542 → **NABAGGALA CATHERINE …9292**: 9 transfers, **UGX 415.4M**. Each went out within
  minutes of the matching WELILE credit on 11, 14–18 and 21–23 Sep.
- Company MTN line → "EQUITY BANK LIMITED": **UGX 157.8M**. The destination account is not shown in
  the SMS.

That is roughly UGX 573–655M of treasury money heading to the bank-payout side, against about
UGX 500M of bank payouts. The claims were the company's own money, not the agent's. This matches the
CFO's standing position that the company owes merchants nothing
([[project_merchant_oop_pending_bucket_not_real_debt]]).

**Not proven:** that account …9292 is the account desk B pays from. The timing matches, but nothing in
the data links …9292 to Sky Bubbles (whose registered Equity account is …7076). Finance should confirm.

## What was done

1. **Closed the 478 claims.** Status changed `pending_reimbursement → rejected`, with
   `reviewed_at`/`reviewed_by` (CEO) stamped and `review_note` starting
   `TREASURY-FUNDED BANK PAYOUT 2026-09-25:`. Audit row: `system_events`
   `02346834-0db4-4ee7-8f37-7edb7f304c8c` (operation `merchant_oop_treasury_funded_close_out`,
   with every advance id). No ledger or wallet movement. It can be reversed (`rejected →
   pending_reimbursement` is a legal transition). The `reviewed_at` stamp also stops the classifier
   from reviving the rows.
2. **Fixed the root cause** in migration `20260925140000_bank_transfer_payouts_not_merchant_oop.sql`,
   applied live via query_database. A completed `bank_transfer` payout that float doesn't fully
   cover now takes the existing no-receivable branch: `merchant_payout_funding.funding_source =
   'needs_review'`, with a treasury-funded note and no claim rows. Float that was actually consumed is
   still recorded. Finance can still raise a claim by hand with evidence. MoMo payouts are unchanged.
   **The rule is forward-only from 2026-09-25 06:00 UTC**, so older open bank claims on other desks
   (Mudumba samuel UGX 577,011 payout plus small telecom rows on Bayo Mercy, Claire, Apophia and
   Babrah) are not rewritten.

`classify_merchant_payout_funding` is not in `critical_function_baselines`.

## Left open on desk B (deliberately)

- One MTN payout claim of UGX 6,500,000 (withdrawal for GRACE PAUL OCHIENG, 12 Sep, float used 0).
  It is not a bank transfer, so it is outside this fix. Finance should decide it.
- Three telecom claims of UGX 2,000 each (2 bank, 1 MTN) whose payout rows aren't pending.

## Related, still uncorrected

- The Sky Bubbles over-credit of UGX 10,202,000 from 2026-08-25 ([[project_float_set_to_vs_add_overcredit]]).
- On 2026-08-27 an operator set this desk's float to UGX 46,350,000,000 (a typo for 46.35M) and
  corrected it 90 seconds later with an `admin_correction`. A production-only sum of the float bucket
  therefore shows +46.4bn. The wallet projection is correct (float 0), so use `wallets`, not raw sums.

## Verify after the next bank payout by desk B

```sql
select f.funding_source, f.notes, f.float_consumed_principal
from merchant_payout_funding f join withdrawal_requests w on w.id=f.withdrawal_id
where f.agent_id='1a88b1b8-6601-477b-b119-8e18d5dc9ebd' and w.payout_method='bank_transfer'
  and w.processed_at >= '2026-09-25 06:00+00';
-- expect needs_review + 'Bank-transfer payout: ...' note, and no new pending_reimbursement rows
```
