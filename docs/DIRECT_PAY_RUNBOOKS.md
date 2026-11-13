<!--
Author: SSENKAALI PIUS
Email: ssenkaali.pius@welileapp.com
Date: 2026-11-13
Website: welileapp.com
-->

# Pay the landlord directly: runbooks

These are for Landlord Ops, the COO and the on-call engineer. Each runbook says what you see, what it means, and what to do. Background is in the plan doc: <https://claude.ai/artifact/C3ihdjpASTDLXwGnLrCsYs>.

**Emergency stop:** turn the switch `self_support_direct_pay` OFF in `pipeline_switches`. This takes effect at once.

- **Stopped:** new claims are refused.
- **Still works:** partners already holding a plan can still upload their SMS, because they may already have paid, and Landlord Ops can still approve or reject them.

**Health check:** `select public.direct_pay_health();`, open to Landlord Ops, the COO, the CTO and super admin. Every morning at 07:00 the job `direct-pay-health` writes an `audit_logs` row (`action_type = 'direct_pay_health_breach'`) for each target missed.

## 1. A partner paid, but the hold ended first

**You see:** the partner calls +256 748 747134 after an SMS saying "The hold on …'s Rent Plan has ended". Their payment is `expired`, and their SMS is not in the system.

1. Ask for the SMS and check it. It should show the landlord's verified number, the amount and the Transaction ID.
2. Check the Rent Plan is still free: nobody else has claimed or funded it.
3. **If it is free:** the partner claims it again ("I'll pay the landlord myself") and uploads the SMS. "Paid before the hold" will be flagged, because the SMS is older than the new hold, so Landlord Ops must write that reason when approving.
4. **If another partner has taken it:** the landlord now has the money twice. Landlord Ops call the landlord. Either the landlord returns the partner's money, or Partner Ops place the partner on another Rent Plan with the same landlord. Welile never holds this money and cannot refund it. Write down what was agreed in the payment's call note.

## 2. The landlord denies receiving the money

**You see:** on the call, the landlord says nothing arrived, or the amount is different.

1. Ask the landlord to check the exact Transaction ID and date from the partner's SMS while you wait. Many denials end here.
2. If the landlord still says no, **reject** with the reason in their words. The partner gets an SMS saying Welile never held the money and can't refund it, with the support number.
3. If the SMS was sent to a wrong number (flag "Wrong number"), tell the partner the number it went to. Only that number's owner or their mobile money provider can reverse it.
4. If you suspect a fake screenshot, also tell the COO, with the partner's name and the payment.

## 3. An approval is stuck

**What you see, and what to do:**

| Message on approve | What to do |
| --- | --- |
| OTP not sent | Press Send OTP again. If it still fails, the SMS providers may be down: check `sms_delivery_log` for `source = 'direct_pay_landlord_otp'`. |
| "The code has expired" | Send a new OTP. |
| "Too many wrong codes" | Send a new OTP. |
| "This Rent Plan changed since the partner paid" | Someone funded or changed the plan another way. Reject the payment, and handle the money as in runbook 1, step 4. |
| "The tenant is still repaying another Rent Plan" | Don't approve. Call the partner; Partner Ops decide the next step. |
| "A Transaction ID … was already approved" | This SMS was already used. Reject it. |
| "The partner hasn't signed their partnership agreement" | Ask the partner to sign, then approve. |

## 4. Payments waiting over 24 hours

**You see:** the breach `payments_waiting_over_24h`. Rows marked "Over 24 hours" in the queue are flagged for the COO.

**Do:** the COO assigns a Landlord Ops officer to call those landlords today.

## 5. Messages are stuck

**You see:** the breach `messages_stuck`: more than 10 option 2 SMS waiting over 15 minutes.

**Do:**

1. Check that the job `notify-funder-release-sms` is active in `cron.job`.
2. Check that the SMS providers are up (the last rows in `sms_delivery_log`).
3. Messages retry on their own up to 4 times once the provider is back.

Approvals are never undone by a message failure.

## 6. The SMS reader is failing

**You see:** the breach `sms_reader_failing`: under 90% of screenshots had their amount read in the last 24 hours.

**Why it doesn't block anyone:** proofs are still saved. They are flagged "Photo unreadable" and use the amount the partner typed, so Landlord Ops can still decide every payment, as long as they read the photo carefully.

**Check:**

- that the `LOVABLE_API_KEY` secret is set for the `direct-pay-proof` function;
- the function's logs for `reader_timeout` (the reader is given 20 seconds) or gateway errors.

## 7. A Cover fee is waiting for a top-up

**You see:** the health metric `cover_fees_awaiting_topup` is above 0. The partner's operational float was short when Landlord Ops approved.

**What happens:** the portfolio is already active, and the job `direct-pay-tick` tries to charge the fee again every 15 minutes, once only, as soon as the float covers it.

**Do:** if it waits more than a week, Partner Ops ask the partner to top up their float.

## 8. Unbalanced ledger entry

**You see:** the breach `unbalanced_ledger_group`. This should never happen: every option 2 entry is tested to balance.

**Do:**

1. Turn the switch OFF.
2. Send the group IDs from `ledger_mapped_balance_violations` (joined to `general_ledger` where `source_table = 'funder_offplatform_rent_payments'`) to the CFO and the engineer.
3. Don't post corrections by hand.
