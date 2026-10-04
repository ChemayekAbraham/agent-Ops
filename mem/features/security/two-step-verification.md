---
name: Two-step verification (2MFA)
description: Email-code 2MFA — enabling terminates all other sessions, new devices need an emailed code, blocked for placeholder emails
type: feature
---
Settings → Safety → "Two-step verification".

- Tables: `user_two_factor` (per-user switch + code email), `user_2fa_trusted_devices`, `user_2fa_challenges` (hashed 6-digit codes, 10 min TTL, 5 attempts, 5 codes/hour).
- Edge functions: `two-factor-manage` (enable/disable) and `two-factor-challenge` (status/request/verify). Email template `two-factor-code`.
- Enabling: only the enabling device stays trusted; other `user_device_sessions` rows are deleted and the client calls `supabase.auth.signOut({ scope: 'others' })` to revoke other auth sessions.
- New/unverified device: `TwoFactorGate` (rendered in `GlobalOnboardingGates`) blocks the whole app until the emailed code is verified.
- Accounts on placeholder addresses (`@welile.user`, `@noapp.welile.user`, `@welile.app`, phone-local `@welile.com`) CANNOT enable it — codes could never be delivered. Rule lives in `_shared/twoFactorEmail.ts` and `useTwoFactor.ts` (keep both in sync).
- Disabling requires a trusted device.