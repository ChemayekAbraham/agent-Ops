# 209 — LANA SMS fixed (form encoding) + Twilio key finding (2026-10-08)

**FIXED in code 2026-10-08, edge functions not deployed. Twilio credential NOT fixed (needs a human).**

## LANA (third SMS tier) — root cause
docs.lanasms.com: `POST https://api.lanasms.com/v1/send` takes **form-encoded** parameters (`phone`, `message`), not JSON; success is `{"status":"success",...}`. All 11 call sites sent a JSON body, so LANA saw no `phone` and answered `{status:false,"No phone number provided."}` (115 rejections 09-08..09-24, 22 more to 10-05; last LANA-accepted send I found was months back). The shared helper also required `status === true`, so even a delivered message would have been logged as a failure (the `lana:200_` rows).

Fix: form-encoded body (`URLSearchParams`) + `Content-Type: application/x-www-form-urlencoded` at all 11 sites (`_shared/sendSmsMultiProvider.ts`, approve-withdrawal, broadcast-audience-sms, cto-broadcast-partners-sms, cto-issue-temp-password, landlord-daily-guarantee-sms, notify-withdrawal-claimed, password-reset-sms, send-rent-access-sms, sms-otp, wallet-transfer); `status === true` checks in the three that had it now also accept `"success"`. `sender_id` is kept as before; LANA's docs do not document it, so confirm it does not reject or drop the branded sender on first live use.

**Verify after deploy:** the first LANA attempt after Yoola+AT fail should log `ok:true`. It is only reached when both earlier tiers fail, so it may take a while to see; `sms-test-send` can force one.

## Twilio (fourth tier) — key finding
"The authorization with Key failed" = Twilio code 70051, HTTP 401, via the Lovable connector gateway (`LOVABLE_API_KEY` + `TWILIO_API_KEY`). 47 failures in 30 days (password-reset-sms 13, issue-landlord-payout-otp 34; last 10-05 06:59 UTC), each after Yoola, AT and LANA had all failed. The Board's "backup provider login broken" is this. Needs the Twilio connection re-linked in Lovable, or the tier retired; not fixable in code.
