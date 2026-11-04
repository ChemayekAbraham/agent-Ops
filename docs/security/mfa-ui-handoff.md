# MFA screens: hand-off to the UI side (Gemini / Lovable)

Logic is done and lives in `src/hooks/useAuthenticatorMfa.ts`. What is needed is markup only: two full-screen steps plus an optional reminder. Do not add any data calls; the hook does all of it. Design: `docs/security/mfa-enforcement-design.md`.

## When to show what
Render the screens from `useAuthenticatorMfa(user?.id)` in the same place the other full-screen gates sit (`src/App.tsx`, next to `ForceResetPasswordGate`), **before anything that loads data**. When the server mode is `admin` or `all`, a staff session that has not finished the second step can read nothing: roles, profile and dashboards all return empty. Showing the data first would look like a broken app.

| `stage` | Show |
|---|---|
| `loading` | nothing (or the existing splash) |
| `not_required`, `verified` | the app as normal |
| `prompt` | a dismissible banner or card: "Set up your authenticator app. It will become required soon." with a button that opens the enrol screen. Never blocking. |
| `enrol` | **blocking** full-screen set-up (below) |
| `challenge` | **blocking** full-screen code entry (below) |

## Enrol screen (stage `enrol`, or opened from the `prompt` banner)
1. Call `startEnrol()` once when the screen opens. It returns `{ factorId, qrSvg, secret }` and also puts them in `enrol`.
2. Show `qrSvg` as an image (`<img src={enrol.qrSvg}>`; it is a data URI) and the `secret` as text with a copy button ("Can't scan? Enter this key").
3. Short instruction: install Google Authenticator or Microsoft Authenticator, scan the code, type the 6-digit number.
4. 6-digit code input (reuse the `InputOTP` pattern from `TwoFactorGate.tsx`), button "Confirm". Call `verifyEnrol(code)`. On `{ ok: true }` the hook refreshes the session and `stage` becomes `verified` by itself.
5. Show `error` under the input when set (the message is already user-friendly). Include "Check the time on your phone" because clock drift is the usual cause.
6. A "Sign out" link. No "skip" on a blocking screen.

## Challenge screen (stage `challenge`)
6-digit input, button "Verify", call `verifyChallenge(code)`, show `error`, "Sign out" link, and the line "Lost your phone? Ask a super admin to reset your authenticator." No email or SMS option.

## Copy and terminology
Plain language, short. Say "authenticator app" and "6-digit code". The regulatory words in `CLAUDE.md` apply (never "loan", "lender", "ROI").

## Behaviour to keep
- Do not call any table or `rpc` other than through the hook while the stage is `enrol` or `challenge`.
- Do not cache the stage in localStorage. The server decides.
- If `stage` flips to `verified` the screen must disappear without a page reload.
- Staff with no usable email must be able to complete this; nothing here uses email.

## Test accounts and rollout
The server mode is `shadow` until the admins have enrolled, so these screens will not block anyone yet; `prompt` is the only stage staff will see at first. Super admins switch the mode (`select public.set_staff_mfa_mode('admin', 'reason')`), which refuses while anyone in scope has no authenticator.
