# 246. Google and Apple sign-in moved off the Lovable OAuth broker (2026-10-17)

**Symptom:** after the PDPO move to our own Supabase project, "Sign in with Google" sent the user back to the welcome screen. The app called `lovable.auth.signInWithOAuth` (Lovable's managed broker, `@lovable.dev/cloud-auth-js`), which issued sessions for the disconnected Cloud project.

**Change (logic only, `src/hooks/auth/authOperations.ts`):** `attemptOAuth` now calls `supabase.auth.signInWithOAuth({ provider, options: { redirectTo } })`. Same return shape (`redirected`, `error`), so the funnel tracking and the primary/fallback redirect logic are untouched. `src/integrations/lovable/index.ts` is auto-generated and left alone (now unused by this path). The Supabase client already has `detectSessionInUrl`, so the session is read from the return URL.

**Existing users:** the restored `auth.identities` hold 1,877 google and 25 apple identities (plus 95,873 email, 166 phone). Google's account id (`sub`) is the same across OAuth clients, so these should resolve to the same accounts; Supabase also links by verified email. Verify with a real account after Google is configured.

**Needed outside the code (dashboard, by Josh; secrets never in chat):**
- Google: Cloud OAuth client (Web application); authorized redirect URI `https://byrzshwlentqvktcksem.supabase.co/auth/v1/callback`; client id and secret into Supabase Auth, Providers, Google.
- Apple: Services ID, key, team id into Supabase Auth, Providers, Apple (later).
- Supabase Auth URL configuration already has Site URL `https://welileapp.com` and the redirect allow-list (doc 244).

**Do not ship before the Google provider is enabled** (the button would show a "provider not enabled" error).
