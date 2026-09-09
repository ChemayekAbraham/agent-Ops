# Tell the agent when their phone down payment is paid to the supplier

When the CFO finally releases a phone order, the agent currently learns nothing — only the reviewing officer sees a confirmation. This adds an automatic message to the agent the moment the down payment lands in the supplier's wallet.

## What the agent gets

One notification per released order, sent in three ways:

- In-app notification (bell), so it stays visible in the app.
- SMS to the agent's registered phone.
- Email, when the agent has an email address on file.

Message content:

- The order is approved and the down payment has been paid to the supplier's wallet.
- The phone brand and model, and the amount paid.
- The daily repayment amount and the date daily deduction starts (7-day grace already stored on the order).
- Reminder that the weekly payment to Mo Banja is settled directly with Mo Banja, outside Welile.
- Supplier's name, phone number and email, clearly labelled as the contact for tracking delivery of the handset.
- Note that the order is now in procedure with the supplier.

If the supplier has no phone or email on record, the message still goes out and simply omits the missing detail (it never blocks the release).

## How it works

New backend function `notify-smartphone-order-disbursed`, modelled on the existing `notify-agent-advance-disbursed`:

- Input: the sale id. It reads the sale, the applying agent's profile, the assigned supplier's profile, and the repayment plan figures server-side (nothing sensitive comes from the browser).
- Sends SMS through the existing shared `sendSMS` helper with an idempotency key of `smartphone-disbursed-<sale_id>`, so a repeated release cannot send twice.
- Inserts one `notifications` row for the agent (type `merchandise`) — this is a money event, so it is not covered by the write-suppression policy for chatty notifications.
- Sends the email through the existing transactional email route, with a new template in `supabase/functions/_shared/transactional-email-templates/` reusing the current branding.
- Every step is individually fault-tolerant: a failed SMS or email is logged and reported in the response but never fails the call.

Frontend: in `SmartphoneOrderApprovalQueue.tsx`, after a successful CFO disbursement, invoke the new function fire-and-forget and mention in the officer's success toast that the agent has been notified. No change to the approval flow if the notification fails.

## Not changing

Pricing, down payment amounts, interest/projection, the 7-day grace, daily deduction, the Agent Ops → COO → CFO chain, wallet routing, ledger postings, supplier assignment, and the Mo Banja weekly leg all stay exactly as they are. No new tables, no schema change.
