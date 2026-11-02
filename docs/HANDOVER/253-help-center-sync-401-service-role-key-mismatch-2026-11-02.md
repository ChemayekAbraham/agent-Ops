# 253 — help-center-sync returned 401 for a valid service-role key (2026-11-02)

**Status: DEPLOYED LIVE AND VERIFIED (edge function version 3, `verify_jwt` false). Josh's run on 2026-11-02 returned `ok: true`, 119 sitemap URLs, 119 added, 0 failed, 0 removed.**

## Symptom

`POST /functions/v1/help-center-sync` with the project's service-role key returned `401 unauthorized`. The key decoded as `role=service_role`, `ref=byrzshwlentqvktcksem`, so it was the right key for the right project.

## Cause

The function authorised the caller by comparing the bearer token, character for character, with its own `SUPABASE_SERVICE_ROLE_KEY` runtime variable. After the PDPO cutover (doc 247 era) the runtime's copy of the key does not match the key shown in the dashboard, so no legitimate token passed. The function was also deployed outside git (`supabase/functions/help-center-sync/` did not exist).

## Change

`supabase/functions/help-center-sync/index.ts` (now in the repo):

- `isServiceRole(token, envKey)`: accepts the token if it equals the runtime key, or if it passes `auth.admin.listUsers` (an Auth admin call only a genuine service-role key can make). Anon and user tokens still get 401.
- The write client uses the runtime key when present, otherwise the caller's verified token.
- Nothing else changed: fixed host `help.welileapp.com`, off-host redirects refused, nothing deleted when the sitemap looks wrong.

## Follow-ups

- Run the sync and confirm `ok: true` with counts, then check `help_center_articles`.
- Find out why the runtime's `SUPABASE_SERVICE_ROLE_KEY` differs from the dashboard key. Other edge functions that compare the token to that variable may fail the same way.
- Version 3, not 2, was deployed: another version existed between the one inspected and this deploy. Worth a look at who deployed it.
