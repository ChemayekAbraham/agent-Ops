# 249: Information and Security Policy v1.0 (DRAFT): controls applied and records created (2026-10-22)

The DPO (Bwayo Mark Donald) drafted an Information and Security Policy (22/10/2026, awaiting CEO approval). The PDF is not changed. This note records what Engineering checked and did so the system meets its requirements.
Full clause-by-clause status: `docs/security/policy-compliance-matrix.md`. Registers the policy requires Engineering to keep: `docs/security/register-of-systems-and-third-parties.md`, `docs/security/risk-register.md`, `docs/security/incident-log.md`.

## Applied to production 2026-10-22
1. **Audit log is append-only (§10 "protected against alteration").** Migration `20261022100000_audit_logs_append_only.sql`. `audit_logs` (about 492,500 rows since 2026-03-09) could be altered at privilege level (`authenticated` held UPDATE/DELETE/TRUNCATE; `anon` held SELECT). Now: `anon` has no access; `authenticated` keeps INSERT and SELECT; triggers refuse UPDATE, DELETE and TRUNCATE for every role unless the transaction sets `app.audit_correction = 'on'`; the only legitimate editor, `cfo_correct_trail_entry` (CFO only, service role, keeps an `edit_history` of previous values), now sets that flag for its own UPDATE. Tested in a rolled-back transaction: UPDATE, DELETE and TRUNCATE refused (42501); the CFO correction path still works. The only existing trigger (IP capture) fires on INSERT and is unaffected. Undo: drop `trg_audit_logs_no_update_delete`, `trg_audit_logs_no_truncate` and function `audit_logs_block_alteration`.
2. **Quarterly access review tool (§5).** Migration `20261022110000_staff_access_review_report.sql`: `public.staff_access_review()` lists every enabled staff account with roles, staff permission, emailed-code 2FA status, last sign-in, password-change record and flags. Callable only by super_admin, ceo, cto, access_admin or the service role (a non-staff caller is refused, tested). First run: 59 staff, 10 admins, 58 without 2FA, 1 never signed in or inactive over 90 days, 39 with no recorded password change.

## Findings that need a decision (not changed)
- **MFA (§5) is NOT MET:** the emailed-code second step is enabled for 1 of 59 staff and 0 of 10 admins; Supabase MFA has 0 factors. Enforcing it changes staff sign-in and could lock people out; needs a design with a recovery path (risk R3).
- **Default staff password (§6):** 39 of 59 staff have no recorded password change since the record began on 2026-09-13. Decision: force a reset (R5).
- **Personal devices (§7):** laptop exports are encrypted but not yet deleted; OneDrive copies remain (R1, R10).
- **Backup links in email (§9):** download links are not access-controlled storage (R2).
- **Log retention (§10):** the defined period is a DPO/CEO decision (propose 7 years for `audit_logs`).
- **Third parties (§11):** hosting countries, sub-processors and agreements are TO CONFIRM for every vendor; the register lists 14 services found in the code, including some not previously on the list (a geocoder, a chart-image service, two IP lookups).
- **All 59 staff logins use non-company email addresses** (R12).

## Status of earlier work this policy touches
Doc 247 steps 1 to 37 (grants, views, anon write rights, wallet reads, email guard, voice callback). The email guard still needs its edge functions deployed; the SMS delivery-report and USSD callback URLs in Africa's Talking still need to be pointed at the new project.
