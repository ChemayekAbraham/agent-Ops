# 221 — Suppressed e-mails get their own line in the CTO report (2026-10-13)

**Status: DB APPLIED 2026-10-13 (migration `20261013120000`). Edge function `daily-cto-report` edited, NOT deployed** (the new tile stays blank until it is).

"Outbound notification delivery failures" (37 users, 10-12) was all `status='suppressed'` e-mails: the address is on the suppression list, so we chose not to send (doc 220). `get_cto_issue_intelligence` now excludes `suppressed` from `failed_*` and returns `suppressed_today/_7d/_30d`. Verified for 10-12: failed_today 0, suppressed_today 37; the notification issue no longer fires. Remaining 7-day failures: 21 `coo-partner-broadcast`, "TTL exceeded (60 minutes)" (email queue, not SMS).
`daily-cto-report` section 6 gains an "Emails suppressed today" tile (`M.suppressed_today`, already in the daily-report email block). Supersedes the "keep suppressed counted" choice in `20260913150000`.
Deploy: ask Lovable to deploy `daily-cto-report`.
