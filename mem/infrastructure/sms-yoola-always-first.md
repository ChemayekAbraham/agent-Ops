---
name: Yoola always first on every OTP send and resend
description: OTP/password-reset SMS must always try Yoola first; no rotation away from Yoola on resend
type: constraint
---
Yoola is ALWAYS the first provider attempted for `sms-otp` and
`password-reset-sms` — on first sends AND on resends. Africa's Talking, LANA and
Twilio are fallbacks only, tried in order when Yoola is unconfigured or rejects.

Do NOT reintroduce the "rotate away from the previously accepted provider"
(`preferBackupRoute` / `previousAcceptedProvider`) behaviour: it pushed resends
onto Africa's Talking (sender silently dropped) and LANA (out of credits), so
resends were less likely to arrive than the first send. The option flags remain
in the signatures but are intentionally ignored.
