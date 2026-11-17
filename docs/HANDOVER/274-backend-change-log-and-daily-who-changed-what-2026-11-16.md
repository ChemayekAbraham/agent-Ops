# 274 — Backend change log and daily "who changed what" (2026-11-16)

**Status:** migration `20261116103000` APPLIED TO PRODUCTION 11-16 and tested. `daily-cto-report` edge function change on `dev/financial-ops`, NOT DEPLOYED, NOT PUSHED. Commit harvest still broken until the GitHub token is renewed (below).

## Ask (CTO)

See every backend change any developer makes, whenever it is made.

## What was found

- An engineering-contribution system already exists (`engrep_*` tables, HR page `EngineeringContribution`, cron `engrep-harvest-commits-1705-eat`). It pulls each day's commits from GitHub and tags them per engineer.
- **It has failed every day since 2026-10-10** with `github 401: Bad credentials`. The cron row still says `succeeded` because only the HTTP call is checked. The last commit recorded is 2026-10-09, so nothing after that is attributed to anyone.
- Nothing recorded database changes as they happen. A table, policy, grant or function changed directly in the SQL editor left no trace except the nightly catalog snapshot.

## What was built

1. **`public.schema_change_log`**: one row per object created, altered, dropped, granted or revoked. Columns: `at`, `command_tag`, `object_type`, `schema_name`, `object_identity`, `statement` (first 8,000 characters of the SQL that ran), `db_role`, `app_name`, `client_addr`. It is filled by event triggers `zz_schema_change_log` (ddl_command_end) and `zz_schema_change_log_drop` (sql_drop). A failure inside the trigger is only a WARNING, so it can never block a change. Readable by `cto` / `super_admin` (with staff MFA); writable only by the triggers and `service_role`.
2. **`public.get_backend_change_digest(since, until)`** (service_role only) returns:
   - harvest health (last good run, days since, last error)
   - commits per person, with backend / migration / edge-function counts and their latest messages
   - every database change in `public`
   - **database changes with no migration in git**: objects changed live that no harvested commit claimed within 3 days. These are the off-the-books edits.
3. **`daily-cto-report`** has a new block above the Executive Summary, "Backend changes — last 24 hours (who changed what)". It shows a red banner while the commit harvest is failing.

Tested in production: create, alter and drop of a probe table were all logged with their SQL and `postgres / mgmt-api`. The digest on 2026-10-08 data lists 8 authors (SP · pius22, JW · joshwanda17, Lovable without co-author, and others). `authenticated` cannot execute the digest or insert into the log.

## Limits

- The database sees a login role (nearly always `postgres`) and an app name (`mgmt-api` = Supabase API/MCP, `postgrest`, the dashboard and so on), not a person. The person comes from git.
- `cron.schedule()` changes and edge-function deploys made outside git are not DDL and are not in this log.
- "No migration in git" means nothing while the commit harvest is broken: every change shows there.
- Engineers are shown as initials plus GitHub handle because `engrep_engineers.staff_id` is not linked to profiles.

## To do (CTO)

1. **Renew `ENGREP_GITHUB_TOKEN`**: a GitHub fine-grained token with read access to Contents and Metadata on the repo in `ENGREP_GITHUB_REPO`. Set it in Supabase → Edge Functions → Secrets.
2. Backfill the gap: call `engrep-harvest-commits` with body `{"day":"YYYY-MM-DD"}` for each day from 2026-10-10 to today.
3. Deploy `daily-cto-report`.

## Rollback

`supabase/rollbacks/20261116103000_schema_change_log_and_backend_change_digest.rollback.sql` drops the triggers and functions and keeps the log table.
