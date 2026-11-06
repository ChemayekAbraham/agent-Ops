# 264. Staff MFA: pilot, then a forced-enrol date (2026-11-06)

**Status:** BUILT on `dev/withdrawal-pin`. SQL tested on the live project in a rolled-back transaction (11 checks, all as expected). **Not applied, not pushed.** The app change is small and not run in a browser.
**Origin:** Josh (CTO), 2026-11-06: "enhance the authenticator app (TOTP) and force every user to enrol". Scope chosen by Josh: his account and Pius first; **after 10 days notify every staff user and force the enrol step.**
**Builds on:** doc 249 and `docs/security/mfa-enforcement-design.md` (phase 0: mode `shadow`, `staff_mfa_ok()`, `staff_mfa_readiness()`, `set_staff_mfa_mode()`, `mfa-admin-reset`).

## 1. Decisions recorded

* **Factor:** authenticator app (TOTP). Passkeys and hardware keys were checked and are **not available**: the Supabase dashboard for `byrzshwlentqvktcksem` does not list WebAuthn MFA, although the installed `auth-js` 2.89.0 has an experimental `webauthn` factor type. Phone (SMS) MFA was rejected (SIM-swap risk, about USD 75 a month). Re-check the dashboard in a few months; enforcement already works for any factor that raises the session to `aal2`.
* **Scope:** staff accounts only (59 at 2026-11-06: 10 admins, 49 other staff roles). Field agents and the roughly 98,000 other accounts are out of scope; this is the reading doc 249 asks the DPO to confirm.
* **Timeline:** now: Josh and Pius enrol (pilot, mode stays `shadow`, nothing blocked). Day 10 (Monday 2026-11-16): notify every staff user and switch the forced enrol step on.
* **State at decision time (production, read-only):** mode `shadow`; 59 staff in scope; 1 enrolled (Collins Tumwiine, employee); 0 of 10 admins enrolled; Josh's account had 13 live sessions, all `aal1`.

## 2. What was built

Migration `20261106120000_staff_mfa_force_enrol_date.sql` (+ `.rollback.sql`):
* `staff_mfa_config.force_enrol_from timestamptz` (null = never forced).
* `my_staff_mfa_status()` (same body as production plus two keys): `force_enrol` is true when the mode is not `off`, the user is staff, has no verified authenticator, and `now() >= force_enrol_from`; `force_enrol_from` is returned too.
* `set_staff_mfa_force_enrol(p_from, p_reason)`: super_admin or the database owner only, a reason of 10+ characters, audited (`security_setting_change`). `null` switches it off.

App: `src/hooks/useAuthenticatorMfa.ts` sends a staff member with `force_enrol` and no authenticator to the existing full-screen enrol step (`AuthenticatorSetupScreen`: no skip, only "Sign out"). Until the date, staff without an authenticator keep seeing the optional banner (`AuthenticatorPromptBanner`), which already acts as an in-app notice.

**Nothing is blocked in the database by this.** The mode stays `shadow`; the forced step only gates the screens. Switching the database to `admin` or `all` is a separate step that `set_staff_mfa_mode()` still refuses while anyone in scope is not enrolled.

## 3. Tested (live project, rolled back, three fake users)

No date: prompt true, force false. Date passed: force true. Non-staff user, date passed: false. Date in the future: false. Mode `off`: false (the kill switch also kills the forced step). Enrolled user, date passed: enrolled true, force false. An employee calling the setter is refused (42501); `anon` cannot execute it; a short reason is refused; 4 audit rows written; afterwards nothing remained.

## 4. To do on the day (2026-11-16)

1. Apply this migration beforehand and set the date: `select public.set_staff_mfa_force_enrol('2026-11-15 21:00:00+00', 'Josh (CTO): staff must enrol their authenticator app from 16 Nov');` (21:00 UTC is 00:00 East Africa Time on 16 Nov). Needs a super_admin or the database owner.
2. Send the notice to all staff (they need the app and 5 minutes). Staff with no phone that can run an authenticator app, and shared devices, need a plan before the date.
3. Have the reset-holders (the super_admins Benjamin Muhanguzi and Nabukenya Hellen) ready: `mfa-admin-reset` is the only recovery for a lost phone. Test one reset during the pilot first.
4. Watch `staff_mfa_readiness()` until enrolled = 59. Only then consider mode `admin`, then `all`.

## 5. Risks and break-glass

* The forced screen has no skip: a staff member who cannot enrol is stuck on it until they sign out. Break-glass: `select public.set_staff_mfa_force_enrol(null, '...')` (off for everyone, immediate, no deploy), or mode `off`.
* Notice and forcing on the same day gives no grace. The design doc proposed 7 days of reminder; to add grace, set the date 3 to 7 days after the notice (the setter takes any date).
* TOTP has no recovery codes: ask each person to enrol a second device (up to 10 factors are allowed).
* Not covered: field agents, tenants and other accounts; the money/admin edge functions are gated by `requireStaffAal2` only as far as phase 2 already wired them (see doc 249).

## 6. Rollback

`select public.set_staff_mfa_force_enrol(null, 'switching the forced enrol step off')` (non-destructive), or `20261106120000_staff_mfa_force_enrol_date.rollback.sql`.
