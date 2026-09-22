# 104 — Native Android app scaffolded (`mobile/android`), email/password auth built and verified

**Built 2026-09-22.** Before touching `mobile/android/`, know it is a fully independent Gradle
project — no code, dependencies, or build tooling are shared with the web app. It talks to the
same Supabase project but is otherwise a from-scratch codebase.

## What was asked

Josh wants a native mobile app (not a PWA/Capacitor wrapper) with separate Android and iOS
codebases, buildable/runnable from Android Studio, built feature-by-feature — starting with auth.

## What exists now

`mobile/android/` — a standalone Kotlin + Jetpack Compose Gradle project (Gradle 8.9, AGP 8.5.2,
Kotlin 2.1.0, minSdk 26, compileSdk/targetSdk 34). Opens directly in Android Studio via
`File > Open` on that folder.

Auth, email/password only, against the **same** Supabase project the web app uses
(`wirntoujqoyjobfhyelc`), via the official `supabase-kt` SDK (`auth-kt` 3.0.3, not hand-rolled
REST calls):

- `AuthRepository` (`app/src/main/java/com/welile/app/auth/`) — `signUp` (mirrors
  `src/hooks/auth/authOperations.ts`'s metadata: `full_name`, `phone`, `role`, tagged
  `signup_source = "android_native"`), `signIn`, `signOut`, `fetchRoles` (reads `user_roles`,
  same table `roleManager.ts` reads — wired but not yet surfaced in the UI).
- `AuthViewModel` + Compose screens (`LoginScreen`, `SignUpScreen`, `HomeScreen` placeholder),
  navigated via `AppNavHost`, which reacts to `supabase.auth.sessionStatus` to route
  authenticated/unauthenticated.
- Secrets (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) load from a gitignored `secrets.properties` into
  `BuildConfig` fields — never hardcoded, never committed. `.env` was not read (hands-off, per
  CLAUDE.md); the anon key still needs to be pasted into `secrets.properties` by whoever runs
  this — copy `secrets.properties.example`.

## Explicitly out of scope this pass

- **Phone OTP login** — the web app's `sms-otp` (send/verify) + `otp-login` edge-function flow.
  Read both functions' source before building this: `sms-otp` action=`send` takes
  `{phone, category}`, `otp-login` takes `{phone, otp}` directly (it re-verifies the code itself
  and returns a `token_hash` for a first-party `verifyOtp` magic-link exchange — does **not** go
  through `sms-otp`'s own `verify` action for login).
- Google/Apple OAuth (web app brokers this through `lovable.auth`, not raw Supabase OAuth —
  needs separate investigation), PIN/biometric login, device sessions.
- Persona dashboards (tenant/agent/landlord/supporter) — `HomeScreen` is a stub.
- iOS entirely — needs a Mac with Xcode, cannot be built or run from this (Windows) machine.

## Verified, not just written

I have no Android Studio UI/emulator access in this environment. What I *did* verify: real
Gradle wrapper (jar fetched, not stubbed), real Android SDK on this machine
(`C:\Users\USER\AppData\Local\Android\Sdk`), `./gradlew :app:compileDebugKotlin` and
`./gradlew :app:assembleDebug` both ran clean against the actual `supabase-kt` library (caught
and fixed one real compile error — `SessionStatus` lives in
`io.github.jan.supabase.auth.status`, not `io.github.jan.supabase.auth`) and produced an
installable `app/build/outputs/apk/debug/app-debug.apk` (13MB). Running it on a device/emulator
and confirming sign-up/sign-in actually reach Supabase still needs Josh, in Android Studio, with
a real `secrets.properties`.
