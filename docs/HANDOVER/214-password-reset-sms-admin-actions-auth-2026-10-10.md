# 214 — password-reset-sms: admin actions now require a real privileged caller

**Date:** 2026-10-10 · **Status:** BUILT, edge function not deployed.

## Problem
`supabase/functions/password-reset-sms` runs with `verify_jwt = false`. Its three admin actions were effectively unauthenticated:

- `admin_reset_password` — no caller check at all.
- `admin_reset` — only checked that an `Authorization` header *existed* (any string passed).
- `admin_delete_user` — same header-only check.

Anyone who knew a user id could set that account's password or delete the auth user, using the service-role client.

## Change
Added `requireAdminCaller()`. All three actions now:

1. Validate the bearer token with `auth.getUser(token)` (401 if missing/invalid).
2. Require an **enabled** `user_roles` row with role `manager`, `super_admin` or `cto` (403 otherwise).

`admin_reset_password` also now enforces the 6-character minimum the other action already had. The actions were **kept** (not removed) on Josh's instruction. No in-repo caller uses them.

## Follow-up (not done)
- Deploy the edge function (Lovable or manual deploy workflow), then notify Lovable.
- Past exposure: check `password_change_audit` for unexpected changes and `auth.users` for unexpected deletions.
- `otp-login` counts attempts only after a correct code; wrong guesses are unlimited. Not yet fixed.
