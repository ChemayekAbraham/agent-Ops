# Brief: staff authenticator-app screens (for the UI owner)

**Goal.** Build the screens that let staff set up and use an authenticator app (Google Authenticator, Microsoft Authenticator). The server side is finished and tested; without these screens nobody can enrol and enforcement cannot be switched on. This is required by §5 of the Information and Security Policy (multi-factor authentication for administrators and staff).

**You build markup only.** All logic is in `src/hooks/useAuthenticatorMfa.ts`. Do not change it and do not add any other data call.

## Before you start
The hook and the server pieces are on branch `dev/revoke-anon-sensitive-views`, not yet on `lovable` (6 commits). Work from that branch, or wait until Josh has promoted it. Do not push to `lovable` yourself; branch from `dev/revoke-anon-sensitive-views` and tell Josh when it is ready.
Read first: `docs/security/mfa-ui-handoff.md` (what each stage means) and `src/components/account/TwoFactorGate.tsx` (the code-entry input pattern to reuse).

## What to build
1. **`AuthenticatorSetupScreen`** (stage `enrol`): full screen, blocking.
   - Call `startEnrol()` once on open. Show `enrol.qrSvg` as an image and `enrol.secret` as text with a copy button ("Can't scan? Enter this key").
   - Steps in plain words: 1. Install Google Authenticator or Microsoft Authenticator. 2. Scan this code. 3. Type the 6-digit number it shows.
   - 6-digit input (reuse `InputOTP`), button "Confirm" calling `verifyEnrol(code)`. Show `error` under the input. Add the hint "If the code is rejected, check that the time on your phone is automatic."
   - "Sign out" link. No skip button.
2. **`AuthenticatorChallengeScreen`** (stage `challenge`): full screen, blocking. 6-digit input, button "Verify" calling `verifyChallenge(code)`, show `error`, "Sign out" link, and the line "Lost your phone? Ask a super admin to reset your authenticator." No email or SMS option.
3. **`AuthenticatorPromptBanner`** (stage `prompt`): a dismissible, non-blocking card: "Set up your authenticator app. It will soon be required to sign in." with a button that opens the set-up screen. Dismiss lasts for the session only (do not store it).
4. **`StaffAuthenticatorGate`**: one component that reads the hook and renders the right one of the above. Mount it in `src/App.tsx` beside `ForceResetPasswordGate` (around line 1086), before anything that loads data. For `loading`, `not_required` and `verified` it renders nothing.

## Rules
- When the server mode is `admin` or `all`, a password-only staff session can read no table. The gate must show the screen first; never let the app load data behind it.
- The screens must disappear by themselves when `stage` becomes `verified` (no reload). Do not cache the stage in localStorage.
- Do not touch the old emailed-code `TwoFactorGate` (it stays switched off) or `DeviceStepUpGate`.
- Mobile first (staff use phones), light and dark theme, large tap targets, `autocomplete="one-time-code"` on the input, labels for screen readers.
- Copy is plain and short. House terms apply (Rent Plan, Supporter, Returns; never loan, lender, ROI).

## How to test (nobody may enrol for real yet)
- Server mode is `shadow`, so the only stage staff see today is `prompt`. To check the other two screens, add a local-only preview: when `import.meta.env.DEV` is true, `?mfaPreview=enrol` or `?mfaPreview=challenge` forces that stage with mock data. It must not ship in production builds.
- Enrolling a real account while the Supabase setting "Limit duration of AAL1 sessions" is on will sign that account out every 15 minutes until the challenge screen is live. **Do not enrol real accounts until this brief is deployed and tested.**
- After deploy, Josh tests with one account: prompt appears, set-up completes, sign out, sign in, challenge accepts the code, wrong code shows the error, lost-phone line is visible.

## Done when
- The three screens and the gate exist, are wired in `src/App.tsx`, and render correctly at phone width in both themes.
- `npm run guard:all` passes and the type check is clean.
- A short note to Josh lists the files changed and how to preview each stage.
- Nothing else in the app changed.
