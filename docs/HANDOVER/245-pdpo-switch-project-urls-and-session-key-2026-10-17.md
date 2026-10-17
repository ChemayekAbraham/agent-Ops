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
