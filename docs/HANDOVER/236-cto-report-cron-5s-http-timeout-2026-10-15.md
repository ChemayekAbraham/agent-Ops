# 236 — Daily CTO report stopped because the cron's HTTP call timed out at 5 s (2026-10-15)

**Status:** migration written (`20261015090000_cto_report_cron_http_timeout.sql`), **NOT APPLIED**. Applying it changes two production cron jobs.

## Symptom
No "Welile Daily Tech Diagnostic Report" for the nights of 13 and 14 Oct (last delivered: reporting day 12 Oct).

## Findings (2026-10-15)
- `daily-cto-report-tech` (jobid 10292, 21:00 UTC) is active and `succeeded` on 13 and 14 Oct. That only means the HTTP request was queued.
- The function itself works: `POST /daily-cto-report {"preview":true,"date":"2026-10-14"}` returned a valid 77 KB PDF in 13 s.
- Neither report job sets `timeout_milliseconds`, so pg_net's **5000 ms default** applies. `net._http_response` shows 152 calls in the last ~7 h with "Timeout of 5000 ms reached".
- The nightly `get_cto_daily_report()` (job 39041, 20:55 UTC) ran ~2 s through 12 Oct and ~8 s on 13 and 14 Oct. Build time passed 5 s, which fits the 12 Oct report arriving and the next two not.
- Not proven: Supabase edge function logs were not available to confirm the handler was cancelled on client hang-up. The theory fits every observation; a real run after the migration is the test.

## Fix
`20261015090000_cto_report_cron_http_timeout.sql` rewrites both report jobs' commands in place to add `timeout_milliseconds := 120000` (auth header stays in the job, not in the file). Idempotent; raises if the job has no `body :=` to anchor on.

## After applying
1. `select jobname, command ~* 'timeout_milliseconds' from cron.job where jobname in ('daily-cto-report-tech','weekly-cto-report-board');` should be true for both.
2. The 21:00 UTC run tonight should mail the report. If it does not, the cause is elsewhere (Mailgun send); read the function logs.
3. The missed 13 and 14 Oct reports were not re-sent; a manual send needs Josh's go-ahead.

## Wider note
152 timeouts in 7 h means other cron-called functions also run on the 5 s default. Which ones is not recorded in `net._http_response`; list `cron.job` commands with `net.http_post` and no `timeout_milliseconds`.
