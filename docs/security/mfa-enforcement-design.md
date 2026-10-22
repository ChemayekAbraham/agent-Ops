# Design: server-enforced multi-factor authentication for staff (Policy §5)

Status: DESIGN for CEO/DPO approval, 2026-10-22. Nothing here is built yet. Owner: Engineering. Figures verified against production on 2026-10-22.

## 1. Requirement
Policy §5: "Multi-factor authentication is required for administrative accounts and for all access to systems holding personal data."
Proposed reading (DPO to confirm, see section 9): administrative accounts = the 10 admin-role users; all access to systems holding personal data = every account that can see other people's personal data through staff tools = the 59 enabled staff accounts, with field agents handled in a later phase.

## 2. Where we are (verified)
- **No second factor is enforced today.** An emailed-code step per new device exists (`two-factor-challenge`, `_shared/staffMfa.ts`: any role outside agent/tenant/landlord/supporter is "staff" and must verify each new device). But:
  - the screen that asks for the code (`TwoFactorGate`) was switched off in the app on 2026-10-17 because it blocked sign-in (the email queue was not delivering after the cutover); the only remaining entry is the optional switch in Settings;
  - the server never checks it. The browser talks straight to the database API with the signed-in token, so a stolen or guessed password gives full staff access whatever the screen does. A screen is not a control.
- **The emailed code is a weak second factor for this workforce:** of 59 enabled staff, 9 have no reachable email at all (placeholder addresses cannot receive a code), 50 use personal Gmail, 0 use a company address. If the Gmail is taken over, the code goes to the attacker too.
- **SMS is not dependable either:** Africa's Talking delivery confirmations have been broken since the cutover (callback still pointing at the old project), Yoola never reports delivery, and the `gate` provider fails every message.
- **Supabase's built-in MFA is unused:** 0 factors enrolled. Sessions carry an assurance level (`aal1` password only, `aal2` password plus second factor) in the token, and the database can read it.
- **Population:** 59 enabled staff (10 admin-role: 3 ceo, 3 cto, 4 cfo, 8 coo, 2 super_admin in overlapping roles); 55 signed in during the last 14 days; 15 have ever verified a device.
- **Where authorisation lives (this decides the design):** 809 row-level-security policies and 639 database functions call the one helper `has_role(user, role)`; 121 functions use the report gates. Separately 162 edge functions check roles themselves with the service key.

## 3. Options
| Option | Independent of mailbox/SMS | Works offline / low data | Cost | Fits 9 staff with no email | Enforceable in the database | Verdict |
|---|---|---|---|---|---|---|
| A. Emailed code (today) | No | No | Mail volume | **No** | Not without building it | Keep only as optional device check |
| B. SMS code | No (provider and SIM-swap risk) | Needs signal | Per message | Yes | Not without building it | Not recommended: delivery unreliable |
| **C. Authenticator app (TOTP) through Supabase Auth MFA** | **Yes** | **Yes** | **None** | **Yes** | **Yes: token carries `aal2`** | **Recommended** |
| D. Passkeys / hardware keys | Yes | Yes | Hardware for some | Yes | Needs custom work | Later, for admin roles |

## 4. Recommended design

### 4.1 Factor
Time-based one-time passwords (Google Authenticator, Microsoft Authenticator or similar) enrolled with `supabase.auth.mfa.enroll({ factorType: 'totp' })`. After the code is verified the session upgrades to `aal2`. No email, SMS or provider is involved, so it works for all 59, including the 9 with no usable email. Pre-check before building: confirm TOTP MFA is switched on in Supabase Dashboard, Authentication, Multi-Factor.

### 4.2 Enforce in three layers (server first)
1. **Database (central, one change).** Add `public.staff_mfa_gate(user, role)` and call it from `has_role` (kept as a plain SQL function so the planner still inlines it): for a gated staff role, a session whose token says `aal` other than `aal2` is treated as NOT having the role. Because 809 policies and 639 functions already go through `has_role`, one change covers browser reads, writes and RPCs. The gate is a no-op unless `auth.uid()` equals the user being checked and the caller is a signed-in user, so service-role jobs, cron and edge functions are unaffected. Report gates (`can_view_staff_reports`, `can_view_finance_reports`, ...) get the same check.
2. **Edge functions (explicit, money and admin first).** The 162 functions that check roles with the service key bypass layer 1 (their database calls carry no user token). Add a shared `requireStaffAal2(token)` in `_shared/staffMfa.ts` that reads `aal` from the already-verified token, and call it in the money-moving and admin functions first (approve-*, cfo-*, admin-*, requisition-*, finops-*, delete-user, password and role changes). Generated list to be produced before phase 2; the rest follow.
3. **App screens (UX only).** After password sign-in the app asks Supabase for the assurance level; if `nextLevel` is `aal2` and `currentLevel` is `aal1`, show the enrol or challenge screen. This layer only guides people to the right screen; layers 1 and 2 are the control.

### 4.3 Mode switch (the safety)
One row `security_settings.staff_mfa_mode` with values `off`, `shadow`, `admin`, `all`, read by `staff_mfa_gate`; changed only by a super_admin with an `audit_logs` entry. `off` is the kill switch and takes effect immediately (no deploy), which is the lesson from 2026-10-17: the earlier gate was removed by editing and redeploying the app while staff were locked out.
- `shadow`: nothing is blocked. A report (`staff_mfa_readiness()`) lists every staff account: TOTP enrolled, active sessions and their `aal` (the `auth.sessions` table records it), last sign-in. Sessions at `aal1` are the people who would be blocked.
- `admin`: gate applies to the 10 admin-role users only.
- `all`: gate applies to every enabled staff account (any role outside agent/tenant/landlord/supporter, the same rule the code already uses).

### 4.4 Lock-out and recovery (decided up front)
- Supabase does not issue recovery codes for TOTP. Recovery is an admin reset: a super_admin deletes the person's factor through an admin-only edge function `mfa-admin-reset` (identity confirmed by phone call or in person; never by email alone), writes an `audit_logs` entry, and the person re-enrols. Two named super_admins hold the right so no single person is a bottleneck. A super_admin's own reset requires the other.
- Break-glass: set `staff_mfa_mode` to `off` or `admin` (SQL as the database owner) if the reset path itself fails.
- Enrolment grace: accounts get 7 days in `shadow`-with-reminder before they are gated; staff with no sign-in in 90 days are reviewed with `staff_access_review()` first (offboard instead of enrol).
- Sessions: gating checks the token's `aal`; an `aal2` session stays `aal2` on refresh. Optionally time-box staff sessions in Supabase Auth settings (plan permitting) so a stolen refresh token expires.

## 5. Rollout and success criteria
| Phase | What | Exit test | Proposed date |
|---|---|---|---|
| 0 | Confirm TOTP on in Supabase; build `security_settings`, `staff_mfa_gate`, `staff_mfa_readiness()`, `requireStaffAal2`, `mfa-admin-reset`; mode `shadow` | Gate tested in rolled-back transactions for all four modes; refuses `aal1` staff, passes service role and non-staff; has_role inlining and query speed unchanged on the heaviest staff screens | 2026-10-30 |
| 1 | App enrol and challenge screens (UI hand-off); admins enrol (10 people) | All 10 admins show TOTP enrolled and `aal2` sessions in the readiness report | 2026-11-05 |
| 2 | Mode `admin`; money and admin edge functions gated | No admin lock-out for 5 working days; reset path exercised once | 2026-11-12 |
| 3 | All staff enrol; mode `all`; remaining edge functions gated | Readiness report shows 0 active staff sessions at `aal1`; 9 staff with no email enrolled | 2026-11-19 |
| 4 | Retire the emailed-code staff step; keep it as an optional device check; update the policy matrix | Matrix row §5 MET | 2026-11-26 |

## 6. Work breakdown
- **Engineering, database (me):** `security_settings`, `staff_mfa_gate`, `has_role` and report-gate change, `staff_mfa_readiness()`, update `staff_access_review()` to show TOTP status, tests.
- **Engineering, edge functions (me):** `requireStaffAal2`, `mfa-admin-reset`, apply to the generated function list.
- **UI (Lovable / Gemini lane):** enrol screen (QR code and manual key), challenge screen after password sign-in, "set up your authenticator" reminder for staff in `shadow`. The contract is `supabase.auth.mfa.enroll`, `challenge`, `verify`, `getAuthenticatorAssuranceLevel`; no new backend call is needed for the screens.
- **CTO / HR:** staff communication, a 15-minute enrolment session per person, name the two reset-holders, leaver process feeding `staff_access_review()`.

## 7. Risks and how they are handled
| Risk | Handling |
|---|---|
| Staff locked out (what happened on 2026-10-17) | Report-only phase first; mode switch in the database with immediate effect; two reset-holders; admins before everyone |
| Performance: `has_role` is called by 809 policies and 639 functions | Gate returns immediately unless the caller is the user being checked and a staff role; stays a plain SQL function so it inlines; speed test on heavy staff screens is an exit test for phase 0 |
| Edge functions bypass the database gate | Explicit `requireStaffAal2` on the money and admin functions first; list generated and tracked |
| A person has several roles (agent and staff) | Gate follows the staff role only; non-staff roles are untouched |
| Lost phone | Admin reset flow; ask people to enrol a second device (a second TOTP factor) where possible |
| Cron, webhooks, service jobs | Not affected (service role is not a user session) |

## 8. What this does not cover
Field agents and other users who see tenant data through the agent tools are outside the staff scope; they are covered by the existing shared-device SMS step-up only. See decision 1.

## 9. Decisions needed
1. **Scope (DPO to confirm):** staff and admin accounts now, field agents later or never? A literal reading of "all access to systems holding personal data" would include every agent and tenant, which is not workable; confirm the reading in writing.
2. **Factor:** approve authenticator-app TOTP as the standard (recommended).
3. **Reset-holders:** name the two super_admins who may reset a factor.
4. **Dates:** approve the phase dates above or give your own.
5. **Company email:** all 59 staff use non-company logins today; independent of MFA, decide whether to move them to company addresses (risk R12).
