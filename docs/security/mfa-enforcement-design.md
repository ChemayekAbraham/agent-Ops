# Design: server-enforced multi-factor authentication for staff (Policy §5)

Status: **Phase 0 APPLIED to production 2026-10-22 in report-only mode (nothing is blocked).** Owner: Engineering. Figures verified against production on 2026-10-22.
Applied: `staff_mfa_config` (mode `shadow`), `staff_mfa_ok()`, restrictive policy `mfa_required_for_staff` on all 926 public tables, `staff_mfa_readiness()` report, guarded `set_staff_mfa_mode()` (refuses admin/all while anyone in scope has no verified authenticator; tested), migration `20261022120000_staff_mfa_enforcement_phase0.sql`. In the repo, not deployed: `requireStaffAal2()` in `_shared/staffMfa.ts` and edge function `mfa-admin-reset`.
Baseline from `staff_mfa_readiness()`: 59 staff, 10 admins, 0 enrolled, 55 staff with a live password-only session (all 55, including all 10 admins, would be asked to verify if enforcement were on today).
**Phase 2a APPLIED 2026-10-22 (still report-only):** `require_staff_aal2()` plus `my_staff_mfa_status()` (migration `20261022130000`), and the check as first statement of the 56 `SECURITY DEFINER` functions a signed-in user can call that write money, ledger, withdrawal, role or profile tables: admin_purge_deleted_account_keep_books, admin_restore_soft_deleted_account, admin_soft_delete_account, agent_capture_contact_location, agent_deposit_to_partner, agent_ops_set_agent_frozen, agent_resubmit_rent_request, agent_reverse_tenant_allocation, agent_set_own_contact_email, approve_self_registered_funder, auto_activate_merchant_referral, bulk_recover_gap_alerts, cfo_reconcile_stale_withdrawal, claim_lead_click, claim_tenant_referrer, claim_withdrawal_verified, complete_identity_binding, correct_tenant_location, decide_national_id_unlink, finops_adopt_national_id_name, finops_decide_payout_destination, finops_decide_payout_number_change, finops_revert_holder_name, finops_set_holder_name, grant_dashboard_access, merchant_attach_payout_proof, national_id_link_owner_decision, national_id_link_staff_confirm, ops_link_user_to_agent, ops_set_agent_tier, ops_update_agent_profile, ops_update_user_identity, ops_update_user_location, partner_ops_onboard_proxy_agent, record_identity_image_hashes, redeem_staff_access_code, reject_landlord_payouts, reject_self_registered_funder, release_sub_agent, release_withdrawal_claim, resend_payout_code, revoke_dashboard_access, revoke_nonconforming_merchant_claims, set_landlord_payout_block_exemption, set_my_operating_location, set_tenant_smartphone_status, set_withdrawal_account, submit_identity_photos, submit_national_id, submit_national_id_details, submit_proxy_split_withdrawal, submit_withdrawal_request, void_ledger_entry, welile_home_mark_tenant_verified. Tested in all three modes (shadow: all pass; admin: admin-role users at aal1 blocked, at aal2 pass; all: every staff user at aal1 blocked, at aal2 pass; agent-only users never blocked). App logic written: `src/hooks/useAuthenticatorMfa.ts`; screens hand-off: `docs/security/mfa-ui-handoff.md`. Not yet covered: read-only money RPCs such as `get_receivables_total`, and the 265 functions that check a staff role (next list).
**Supabase Auth settings checked 2026-10-23 (Dashboard screenshot from Josh):** TOTP (app authenticator) = Enabled; phone/SMS MFA = Disabled; maximum 10 factors per user (consider 2 to 3); "Limit duration of AAL1 sessions" appears switched on. **Sequencing risk:** with that limit on, a user who has ENROLLED an authenticator but does not verify a code within about 15 minutes of signing in is signed out. So nobody may enrol until the challenge screen is deployed and tested (otherwise enrolled staff are signed out every 15 minutes with no way to enter a code), or the setting is switched off for the enrolment window. Staff who have not enrolled are not affected.
Still to do: app enrol and challenge screens (UI), then test with one account, then enrol the 10 admins, then switch modes. Sections 1 to 3 below are the original design; section 4.2 layer 1 was changed after measurement.

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
1. **Database (central): a restrictive policy on every table.** `mfa_required_for_staff` (926 tables) calls `staff_mfa_ok()` as `(select public.staff_mfa_ok())`, which Postgres evaluates once per query. In mode `all`, a staff member whose token is not `aal2` reads and writes nothing; non-staff users, the service role, cron and edge functions using the service key are unaffected. **Measured, and why this replaced the first idea:** the first idea was to put the check inside `has_role()` (809 policies and 639 functions use it). The staff policies call `has_role()` once per row, and the gate made a 3,700-row read about 14 times slower (76 ms to 1,103 ms; a lighter gate still about 9 times slower). The restrictive policy measured 100 ms before and 69 ms after (no cost). `SECURITY DEFINER` functions read tables as their owner and bypass these policies, so the money and admin RPCs get an explicit check in phase 2 (same helper idea, once per call).
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
- **UI (Lovable / Gemini lane):** enrol screen (QR code and manual key), challenge screen after password sign-in, "set up your authenticator" reminder for staff in `shadow`. The contract is `supabase.auth.mfa.enroll`, `challenge`, `verify`, `getAuthenticatorAssuranceLevel`; no new backend call is needed for the screens. **Important:** once the mode is `admin` or `all`, a staff session at `aal1` can read NO table, so the app must call `getAuthenticatorAssuranceLevel()` first and show the enrol or challenge screen BEFORE loading roles, profile or any data (those reads return nothing at `aal1`). The enrol and verify calls use the auth API only, not tables, so they keep working. Also needed: a "no usable email" staff member must still be able to sign in and enrol (no email step).
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
