# 245. Repoint hard-coded project references for the PDPO move to our own Supabase project (2026-10-17)

**Status: COMMITTED ON `dev/pdpo-switch-urls`, NOT PUSHED, NOT DEPLOYED.** Needs a push to `lovable` while Lovable's agent is idle (CLAUDE.md), after the PDPO cutover has linked `byrzshwlentqvktcksem`. Companion log: doc 244 (cutover), kept on `dev/cto-report-sms-balance-watch`.

## Why
The database now lives in `byrzshwlentqvktcksem`; the old Lovable Cloud project `wirntoujqoyjobfhyelc` is paused (no access) after disconnect, with no way back. Code that still names the old project would break silently.

## What changed
- **9 transactional email templates**: logo and check-mark images were served from `https://wirntoujqoyjobfhyelc.supabase.co/storage/v1/object/public/email-assets/...` (11 occurrences in 8 template files). They now point at the new project's `email-assets` bucket (public, already copied). Without this every email would show broken images after the old project goes away.
- **`src/lib/sessionCache.ts`, `src/lib/ephemeralGuard.ts`**: they hard-coded the browser storage key `sb-wirntoujqoyjobfhyelc-auth-token`, which supabase-js derives from the project ref. They only *remove* it (sign-out, and the "ephemeral" shared-device session dropped on a cold start), so after the move the removal would hit a key that no longer exists and an ephemeral session would survive a browser close. The key is now derived from `VITE_SUPABASE_URL` and the previous project's key is cleared too.
- **`ephemeralGuard.ts` carry-over (new behaviour, best effort)**: if a browser still holds the session under the old key and none under the new key, it is copied to the new key before anything else runs, so supabase-js refreshes it with the refresh token restored in the new project and the user is not forced to sign in again (each fresh sign-in costs an SMS OTP). If the refresh fails the user is simply signed out, as without it. Not tested against a real browser session yet: test with one account after the switch.
- **`supabase/functions/mcp/index.ts`** (generated bundle, `projectRef` literal) and **`vite.config.ts`** (fallback defaults for `VITE_SUPABASE_URL` and `VITE_SUPABASE_PROJECT_ID`): new project. The MCP OAuth issuer is `https://<projectRef>.supabase.co/auth/v1`, so a stale ref would reject tokens from the new project.
- **`infra/share-proxy/worker.js`** (Cloudflare worker for `/s/` and `/m/` share links): upstreams `og-merchandise` and `og-plan` now point at the new project. **Needs a separate `wrangler deploy` by whoever owns Cloudflare**; merging does not deploy it.

## Not changed (hand to Gemini or Josh)
`index.html` preconnect hint and the dashboard link in `src/pages/admin/Referrals.tsx` (UI files), `.github/workflows/deploy-edge-function.yml` (comment/CI target), `.agents/mcp_config.json`, `.lovable/mcp/manifest.json`, `supabase/config.toml` `project_id` (Lovable resets it on linking; restore the saved copy of the file right after linking), e2e specs.

## Still open for this branch
- **VAPID public key**: hard-coded in `src/lib/webPush.ts` and `supabase/functions/_shared/webPushSend.ts`; the new key pair was set as secrets on the target, so both literals must be changed to the new public key (needs the value from Josh). Until then pushes are rejected (server signs with the new private key but sends the old public key).
- Run `npm run guard:all`: **passed** on this branch (all guards).

## Verification
`npm run guard:all` passed. TypeScript was not compiled locally (it cannot complete here, see memory); the changes are small and typed (`.filter(Boolean) as string[]`).

## Added after the link (2026-10-17 ~05:30 EAT)
- Lovable linked the new project and committed `Connected to new Supabase project` (`.lovable/mcp/manifest.json` issuer, `supabase/functions/mcp/index.ts` projectRef, `src/integrations/supabase/types.ts` regenerated, PostgrestVersion 14.18). `supabase/config.toml` was NOT reset by Lovable (all 109 `verify_jwt = false` entries intact), so only its `project_id` was changed here from `wirntoujqoyjobfhyelc` to `byrzshwlentqvktcksem`.
- This branch merges `origin/lovable` 55ef48fe25 (merge commit, no rebase).

## Safety guards and tooling repointed (2026-10-17, after the link)
- **Database test guards protected the OLD project, not the new live one.** `src/__tests__/foodDbTestGate.ts` (`PRODUCTION_PROJECT_REF`, used by `hostRefusal`, which makes the Food DB harness, that INSERTs into `auth.users` and commits orders, refuse any live database) and the five shell harnesses `supabase/tests/food_m1/local/{run,race,isolation_check,migration_matrix}.sh` and `supabase/tests/ledger_boundary/local/run.sh` only refused `wirntoujqoyjobfhyelc`. They now refuse **both** the new production project `byrzshwlentqvktcksem` and the previous one; the unit test `foodDbHostGuard.test.ts` also proves the previous project is refused. (The guard still refuses `DATABASE_URL`; a variable named `DATABASE_URI` is not checked by it, so do not point test tooling at the live database through that name.)
- `.agents/mcp_config.json` `serverUrl` now `https://byrzshwlentqvktcksem.supabase.co/functions/v1/mcp`.
- The 10 `e2e/*.spec.ts` files mock the Supabase host and seed `sb-<ref>-auth-token`; their `SUPABASE_HOST` / `PROJECT_REF` constants now name the new project. `scripts/stress_test_api.py` default base URL now the new project, and both refs are in `PROD_HINTS`.
- `npm run guard:all` passed.

## Heads-up, not changed
- `.github/workflows/deploy-edge-function.yml` reads the project ref from `supabase/config.toml` (now the new project), so it will deploy to the new project; the GitHub secret `SUPABASE_ACCESS_TOKEN` must belong to an account that can access it. Only a comment still names the old ref.
- `supabase/pending/20261009120000_corr5300000_bucketa_gate_hardening.sql` (and its rollback) grant/revoke to the role `sandbox_exec_wirntoujqoyjobfhyelc`, which exists only on Lovable Cloud and not on the new project (the same missing role caused the 4,136 harmless errors in the restore): remove those role names before applying it, or it fails.
- Still not touched here (UI): `index.html` preconnect, `src/pages/admin/Referrals.tsx` dashboard link.

## CORRECTION: the session carry-over was wrong and is replaced (2026-10-17, ~06:00 EAT)
- **What happened:** after the switch, a live-site user (funder account, phone ending 5473, `welileapp.com`) could not open the funder dashboard: the new project's API logs show **every request from that browser answered 401**, including `/auth/v1/user`. The browser was sending an access token issued by the PREVIOUS project (signed with its keys), which the new project cannot validate, and supabase-js does not refresh until the token's own expiry. Refresh attempts with the old refresh tokens also fail (`/auth/v1/token` 400): the restored `auth.refresh_tokens` are not usable by the new GoTrue. The "carry-over" added earlier in this doc (copy the old session to the new storage key) made it worse: it put the old token where the new client reads it, and the cached session/roles (`welile_session_cache`, `welile_roles_cache`) made the app look signed in while every call failed.
- **Fix in `src/lib/ephemeralGuard.ts`:** the carry-over is removed. At startup the stored session under the current and the previous key is decoded (no libraries, no network); if its access token's `iss` is not `<VITE_SUPABASE_URL origin>/auth/v1` the session is deleted together with the cached session and roles, so the user lands on a normal sign-in (the SMS-code sign-in works on the new project). A session issued by the current project is never touched; malformed values are ignored. Logic tested with 7 cases (old issuer dropped, new issuer kept, no value, not JSON, JSON without `access_token`, non-JWT token, JWT without `iss`).
- **Immediate workaround for an affected user:** sign out or clear site data for `welileapp.com` (or use a private window) and sign in again with the SMS code. Old tokens also stop mattering within about an hour of each user's last old-project refresh.
