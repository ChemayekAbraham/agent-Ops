# 265 — Daily engineering update (plain-English "what the engineers did"), emailed to the CEO

**Status (2026-11-09):** BUILT, NOT DEPLOYED, NOT TESTED, CRON NOT APPLIED. Asked by the CTO.
No "daily features report" existed in the repo, so this is new.

## What it does
Every evening at 18:00 Africa/Kampala (cron `0 15 * * *` UTC,
`daily-engineering-update-report-1800-eat`) **benjamin@welile.com** (CEO) gets one
email, CC **joshwanda17@gmail.com**, listing what the engineers shipped in the last
24 hours in plain English: what now works differently, who it helps, a coloured tag
(NEW / FIXED / SAFER / SMOOTHER / BEHIND THE SCENES), an "INVOLVES MONEY" tag, and a
"Worth your attention" box. No file names, no code words. A day with no commits sends
a one-line "quiet day" email.

## How
`supabase/functions/daily-engineering-update-report/index.ts`:
1. Lists commits on the `lovable` branch of `weliletenants-sys/welilereceipts-com-98bba33b`
   through the GitHub API (merge commits dropped, max 40), plus the folders each one touched.
2. Sends them to the Lovable AI gateway (`google/gemini-3-flash-preview`) with a prompt
   that forces plain language and the mandatory vocabulary (Rent Plan, Supporter, Returns).
3. Formats HTML + text and sends through Mailgun (same stack as the other daily reports).
If the AI step fails the run fails (502) and **nothing is sent**; the CEO never gets raw commit text.

Overrides (`hours`, `to`, `cc`, `dry_run`) work only for a signed-in executive
(`user_roles`: ceo/cfo/coo/cto/manager/super_admin). The anon key gets the default run only.

## Before it goes live
1. Add edge-function secret **`GITHUB_TOKEN`**: fine-grained read-only token, Contents: read,
   on that one repo. (`LOVABLE_API_KEY`, `MAILGUN_*` already exist.)
2. Deploy the function.
3. Test as an executive: POST `{"to":["joshwanda17@gmail.com"],"cc":[],"hours":48}`
   (add `"dry_run":true` first to read the text without sending).
4. Josh reads it and approves, then apply `20261109120000_schedule_daily_engineering_update_report.sql`.

## Caveats
- It reads commits on `lovable`, so work on a dev branch appears only after it is merged there.
- Commit messages like "Changes" (Lovable auto-commits) carry little meaning; the AI leans on
  the touched folders, so those items may be vague. Good commit messages make a better email.
- Not run yet: the GitHub call, the AI JSON parsing and the email rendering are untested.
