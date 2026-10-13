# 222 — All-hands action 001/09: logins, OTPs and 7-day forecast in the daily CTO report (2026-10-13)

**Status: DB APPLIED 2026-10-13 (migration `20261008120000`, doc 206). `daily-cto-report` edited; deploy via Lovable, see below.**

Action 001/09 (WEL/MIN/001, 7 Oct, owner Joshua Wanda, due 14 Oct): "Report successful logins and successful OTPs, with a 7-day system-performance forecast. Done means: automated report with forecast."

## What exists
- `get_cto_auth_metrics_forecast(p_history_days default 14)` is live. Verified against `get_cto_daily_report(2026-10-12)`: login attempts 290 / successes 224 and OTP verifications 22 match exactly.
- 14-day window (10-13): logins 1,741 of 2,322 attempts (75.0%); OTP verified 141 of 219 verify attempts (64.4%); 479 OTPs sent, 29.4% sent-to-verified.
- Forecast next 7 days (trailing mean, range +/- 1 sd, NOT seasonal): ~870 successful logins (466-1,275); ~70 OTPs verified (30-111).
- `daily-cto-report` section 6 now shows 4 tiles + a method line from this RPC (best-effort: report still ships if the RPC fails). Sent nightly to joshwanda17@gmail.com only.

## Reading the numbers (do not quote the 76.4% as platform health)
Login success counts attempts including wrong passwords and unknown numbers; the people-based eventual sign-in rate (84.4% on 10-12, doc 205) is the health figure. OTP "sent to verified" is low because many sends are signup/withdraw/landlord codes, not login. The forecast is a naive flat projection, labelled as such; it says nothing about rollback or SMS, which are reported separately (docs 218-220).

## Still open
- "System-performance forecast" is covered only for logins/OTPs. Rollback rate and SMS delivery have no forecast.
- Minutes list rollback 18.4% (lifetime/daily mixed) and SMS delivery 95.2% (old failure definition); correct figures are in the CTO report.
