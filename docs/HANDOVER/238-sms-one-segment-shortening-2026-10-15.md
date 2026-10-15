# 238 - SMS shortened to one 160-character segment (2026-10-15)

**Status: COMMITTED ON `dev/sms-160`, NOT PUSHED, NOT DEPLOYED. Migrations NOT applied.**

## Why
Yoola bills per segment. Production averaged 2.45 segments per message (11% single-segment). Causes: ~97 chars of footer + sign-up line on every non-OTP SMS, optional marketing fragments on payment notices, non-GSM characters (70-char segments), and verbose copy in ~90 senders.

## What changed
- `_shared/smsFooter.ts`: footer is `Help: <phone>` (17 chars); the `Join Welile: welileapp.com/wjoin` line (33 chars) is appended **only if the whole message stays <= 160**, otherwise dropped (never the message or the footer). New `toGsmSafe` swaps curly quotes, dashes, bullets, ellipsis, arrows for ASCII before sending. Legacy footer wording still detected (idempotent).
- `_shared/tenantTemplates.ts`: `renderSmsTemplate` drops optional fragments lowest-priority-first; `SMS_BODY_BUDGET = 106` (160 - 17 - 33 - slack).
- ~90 edge functions: copy rewritten to <= 143 chars worst case (so body + Help fits), aiming ~110 so the join line also fits. Facts kept (amount, balance, TID/ref, deadline, action, codes, fraud warnings). Regulatory terms respected ("Rent Plan"; `notify-verification-change` "loan" -> "Rent Plan").
- `_shared/withdrawalTracking.ts`: assigned/released SMS fit with the tracking URL (the `Track:` label and `WELILE:` prefix dropped; test updated).
- Migrations (NOT applied): `20261015120000_shorten_tenant_sms_templates.sql` (12 `tenant_notification_events` bodies), `20261015130000_shorten_db_stored_sms.sql` (`system_config.momo_sender_signup_sms`, SMS text of `queue_tenant_rent_intake_stall_notices`). Live rows were read on 2026-10-15 and matched the old wording, so no staff edits are overwritten.

## Behaviour changes to know about
- Free text is clipped in SMS (reasons 25-70 chars, titles/names 15-30, director/staff-requisition comments): full text remains in in-app/email.
- Optional parts (payee note, rollups, advance-limit line, TID/From/Ref lines) appear only while they fit.
- Dropped marketing/filler: greetings, thank-yous, dashboard links, "access up to UGX 30M" lines.
- `rent-plan-transition-notices` uses `pickFit` (richest variant that fits); `messages_test.ts` rewritten accordingly.
- `notify-business-advance-status` SMS now has its own ASCII text (push/email keep emoji copy).

## NOT done / open
- Sender-typed text: `broadcast-audience-sms`, `cto-broadcast-partners-sms`, staff `custom_message` in dormant-bike-lease - length is the sender's.
- `settle_tenant_rent_from_deposit` (writes `tenant_self_repayment_notices.sms_text`, 24k-char function) and the appended access/next-level/growth sentences in `tenant-self-repayment-notices`: still long.
- Live campaign `renewal-survey-oct-2026` (216-225 chars incl. T&Cs): needs Josh's copy decision.
- `tenant_message_templates` (used by `tenant-behavior-messages`) does not exist in production - function's template path is dead there.
- Messages carrying URLs (business-advance, funder/house-booking, signup invite, merchant) fit one segment with `Help:` but not the join line. A few sit at 140-143 and depend on URL/token length.
- Test suite not run locally (no node_modules, tsc cannot complete). Verified: `npm run guard:all` passes; all changed `.ts` pass a node syntax check; lengths measured per message by the editing agents with worst-case sample values.

## Deploy
Merge to `lovable` only when Lovable's agent is idle and with Josh's go-ahead; deploy edge functions and apply both migrations together; then notify Lovable.
