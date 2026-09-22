# Welile — native Android app

Kotlin + Jetpack Compose. Independent Gradle project, separate from the
`welilereceipts-com` web app — no code is shared or reused from the PWA.
Talks to the same Supabase project (`wirntoujqoyjobfhyelc`).

## Open in Android Studio

1. `File > Open` and pick this `mobile/android` folder (not the repo root).
2. Copy `secrets.properties.example` to `secrets.properties` and fill in the
   real `SUPABASE_ANON_KEY` (find it in the web app's `.env` — never commit
   this file, it's gitignored).
3. Let Gradle sync, then Run on an emulator or device.

Command line equivalent: `./gradlew assembleDebug` (JDK 17 required).

## What's built so far

- **Auth (email/password only)**: sign up, sign in, session persistence,
  sign out. Mirrors `src/hooks/auth/authOperations.ts`'s email/password path
  against the same Supabase Auth backend, including the `full_name` /
  `phone` / `role` signup metadata the web app writes.
- Role fetch from `user_roles` (same table `roleManager.ts` reads) is wired
  up in `AuthRepository.fetchRoles`, not yet surfaced in the UI.

## Explicitly not yet built

- **Phone OTP login** (the `sms-otp` + `otp-login` edge-function flow the
  web app also supports) — next auth feature.
- Google/Apple OAuth (the web app routes this through a `lovable.auth`
  broker, not raw Supabase OAuth — needs its own investigation).
- PIN/biometric/device-session login.
- Persona-specific dashboards (tenant/agent/landlord/supporter) — `HomeScreen`
  is a placeholder post-login screen.
- iOS — needs a Mac with Xcode; can't be built or run from this machine.

## Verified

`./gradlew assembleDebug` produces a real, installable
`app/build/outputs/apk/debug/app-debug.apk` from this exact source tree.
