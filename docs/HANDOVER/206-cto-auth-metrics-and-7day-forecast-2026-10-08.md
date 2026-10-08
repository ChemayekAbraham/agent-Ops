# 206 — CTO auth metrics + 7-day forecast (2026-10-08)

**BUILT 2026-10-08. Migration `20261008120000` not applied; not yet run against live data.**

Source: 2026-10-07 all-hands action item "Report CTO metrics — successful logins and OTPs, plus a 7-day system-performance forecast."

## What it is
`get_cto_auth_metrics_forecast(p_history_days int default 14)` — read-only, roles cto/ceo/super_admin/manager/service_role. Returns window totals, a daily series, and a 7-day forecast.

- **Logins:** `login_phase_events` phase `auth.signin.attempt`; success = status `success`. Attempts include wrong passwords and unknown numbers, so ~100% is not reachable (see doc 205).
- **OTP:** verify step from `otp_login_audit` (success = outcome `success`); sends from `sms_delivery_log` source `sms-otp`, final attempt only. Same definitions as `daily-cto-report`.
- **Forecast:** flat projection of the trailing-window daily mean, range = mean ± 1 sd, floored at 0. Not seasonal; label it as such when presenting.

## Reporting caution
This morning's diagnostic quoted auth 76.4% and OTP 77 sent / 65 verified. Those are *attempt* rates. The people-based eventual sign-in rate (doc 205) is the better health figure; quote both and say which is which. Failures are mostly customer outcomes (wrong password, unknown number), not platform faults.

## Still to do
Apply the migration, call the function and sanity-check against `daily-cto-report`. Rollback 18.4% "bot spam" hypothesis from the meeting is **unverified** — see doc 201 (daily delta vs lifetime are different measures).
