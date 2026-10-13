# 221 — Suppressed e-mails get their own line in the CTO report (2026-10-13)

**Status: APPLIED 2026-10-13. DB migration `20261013120000` by hand; `daily-cto-report` edited and DEPLOYED by Lovable's agent from commit 242ff2dae3 (same one-line edit as local a331e2dd0a, so merging `origin/lovable` should not conflict). Tile appears on the next nightly run.**

"Outbound notification delivery failures" (37 users, 10-12) was all `status='suppressed'` e-mails: the address is on the suppression list, so we chose not to send (doc 220). `get_cto_issue_intelligence` now excludes `suppressed` from `failed_*` and returns `suppressed_today/_7d/_30d`. Verified for 10-12: failed_today 0, suppressed_today 37; the notification issue no longer fires. Remaining 7-day failures: 21 `coo-partner-broadcast`, "TTL exceeded (60 minutes)" (email queue, not SMS).
`daily-cto-report` section 6 gains an "Emails suppressed today" tile (`M.suppressed_today`, already in the daily-report email block). Supersedes the "keep suppressed counted" choice in `20260913150000`.
