# Why some users got "random" withdrawal receipt emails

## What actually happened (verified against the live email log)

Two things combined, neither of them a matching bug:

1. **Every completed payout is copied to a wide internal list — by design.**
   When a payout is confirmed, the withdrawal receipt is emailed to the customer *and* fanned out
   as an internal "copy" to: every user holding the `operations` role (**25 people**), every user
   holding the `cfo` role (**3 people**), the merchant agent who processed it, and the fixed archive
   address `weliletenants@gmail.com`. That is ~29 emails per single payout.
   The recipient list in today's log matches the `operations` + `cfo` role holders exactly — so these
   people are not receiving other people's mail by accident, they are receiving oversight copies
   because they carry an ops role. Most of them are field/ops staff who don't need payout copies.

2. **Today's flood was the replayed outage backlog, not new payouts.**
   Of the 277 withdrawal receipts sent in the last 12 hours, **229 were for payouts dated 8 July 2026**
   (plus a few from 13–17 July). Only 17 relate to today. These are the messages that had been stuck
   from the Mailgun transport outage and got released, so staff phones lit up with receipts for
   withdrawals that were settled seven weeks ago — which is exactly why they read as "random".

## Options to fix (pick one or more)

**A. Narrow the oversight copy list (recommended).**
Stop broadcasting to all 25 `operations` holders. Send internal copies only to a small, explicit
finance recipient list (e.g. the CFO holders plus the archive address), or to an opt-in flag on the
staff record, instead of "everyone with the ops role".

**B. Suppress stale receipts on replay.**
Refuse to send a payout receipt whose payout date is older than a short window (e.g. 72 hours) when it
is being dispatched from the queue. Backlogged receipts for July payouts get dropped rather than
delivered weeks late.

**C. Batch the internal copy into a digest.**
Replace per-payout internal copies with one daily payout digest listing all settled payouts, so ops
staff get one email a day instead of one per payout.

**D. Leave sending as-is and only stop the replay flood.**
Purge/expire the remaining stale withdrawal receipts in the queue and change nothing about the
ongoing fan-out.

## Technical notes

- Fan-out lives in `supabase/functions/approve-withdrawal` using
  `buildWithdrawalPaidReceiptRequest` (`supabase/functions/_shared/partnership-emails.ts`), which
  takes `copyFor` (recipient label) + an idempotency suffix per recipient.
- Role lookup for the copy list is `user_roles.role in ('operations','cfo')`; the archive address is
  hardcoded.
- The commission-disclosure policy (`receipt-content-policy.ts`) stays untouched by any of these
  options — customer/internal copies still carry no commission line.
- Any staleness cut-off (option B) belongs in the receipt builder or `process-email-queue` dispatch
  path, and must not affect other templates.
- No schema change is needed for A, B or D. Option C would need a small digest job.

Tell me which option you want and I'll implement it.
