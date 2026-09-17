# National ID FIFO E2E and OTP Delivery Verification

**Date:** 16 September 2026  
**Scope:** National ID creation, duplicate linking, FIFO ownership, OTP delivery, holder decision, requester notification, rejection, expiry, account limit, and reordered-name matching.  
**Safety:** All database scenarios ran inside one rollback-only transaction with synthetic National ID, card, and name values. The transaction ended with `ROLLBACK`; no test records or profile changes remained.

## Production symptom and root cause

The live application had not reached `national-id-link-otp` for the failed attempts: there were no matching link-request rows or function logs. A direct delivery test then exposed a second problem in the shared OTP sender.

Yoola accepted the SMS, but the sender waited for a later delivery-state confirmation. A Yoola status of `sent` was treated as unconfirmed, so the code incorrectly continued to Africa's Talking and LANA. Africa's Talking then rejected the fallback for insufficient balance and LANA rejected it because its request lacked a valid phone value. This created a misleading failure despite Yoola already accepting the SMS.

## Fix made

Only `supabase/functions/sms-otp/index.ts` was changed and only the named `sms-otp` Edge Function was redeployed.

- Yoola remains the primary OTP provider platform-wide.
- A successful Yoola gateway acceptance now ends the provider chain.
- Africa's Talking and LANA run only when Yoola is unavailable, unconfigured, or rejects the send.
- No National ID FIFO, linking, approval, profile, or verification logic was changed.

## Handset delivery test

A National ID link-style test SMS was sent to `0778315407` after deployment.

| Check | Result |
|---|---|
| Edge Function response | `success: true` |
| Provider | Yoola |
| Yoola response | HTTP 200, status `success`, recipient status `Success`, status code `100` |
| Provider message ID | `374579` |
| Logged time | 2026-09-16 15:21:13 UTC |
| Fallback attempted after acceptance | No |
| Delivery-log status | `accepted` |

The secret six-digit code is intentionally not included in this report.

## Rollback-only E2E results

| Scenario | Result |
|---|---|
| New National ID | PASS — details saved and the first account became the FIFO holder. |
| Existing National ID | PASS — submission was blocked as a duplicate and exposed only the holder's first name. |
| OCR-lookalike National ID | PASS — `O`/`0` normalization found the same holder. |
| Duplicate-link request | PASS — created in `awaiting_owner`, expiring seven days later. |
| Server-resolved SMS destination | PASS — the holder's stored phone was resolved without accepting a client-provided destination. |
| Approval before requester enters OTP | PASS — blocked with an explicit message. |
| Approval after valid OTP | PASS — moved to `owner_approved`. |
| Requester status polling | PASS — returned the holder decision; the client polls every 25 seconds and shows a success/error toast on state changes. |
| Linked user's profile name | PASS — later linked account retained its own profile name. |
| Holder rejection | PASS — moved to `rejected_by_owner`, included the reason, and continued to block submission. |
| Seven-day expiry | PASS — stale request moved to `expired`. |
| Twenty-account limit | PASS — submission, hint, and link request all reported the limit at 20 accounts. |
| Reordered names | PASS — `Mata Pius` and `PIUS mata` produced the same normalized key and duplicate set. |
| Reported existing-ID example | PASS — holder first name was returned and direct submission remained blocked pending linking. |

## Holder dialog and requester notification

- `NationalIdLinkGate` is mounted globally for signed-in users.
- The holder dialog cannot be dismissed by outside click, Escape, or a close button.
- Approve remains disabled until the requester has verified the OTP.
- Approve and reject each require a second confirmation dialog.
- The requester polls every 25 seconds and receives a visible notification for approval, rejection, staff rejection, activation, or expiry.

## SMS wording verified

The National ID duplicate-link SMS identifies the requesting Welile user and the relevant National ID, asks the holder to share the code only if they agree, and states that in-app confirmation is also required. Phone-verification messaging remains purpose-specific. A number already owned by another account is rejected server-side before verification rather than silently reassigned.

## Verdict

**PASS after OTP routing fix.** Yoola accepted the production test in one attempt, no fallback followed its acceptance, and all requested FIFO/link state scenarios passed in the rollback-only suite. No test data was retained.