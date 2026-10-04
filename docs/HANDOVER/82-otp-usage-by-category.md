# 82. OTP usage by category (login, withdraw, landlord payout, signup, and everywhere else OTP applies)

**Built and applied live 2026-09-18.** Josh: "WE NEED TO HAVE AT THE END OF THE DAY THE USAGE OF
OTP BY CATEGORY; WITHDRAW, LOGIN EVERY WHERE THE OTP APPLIES." Before touching any OTP send/verify
path, or `get_otp_usage_by_category`, again — read this for the full inventory of every place an
OTP gates something in this codebase and how each one is now counted.

## What was found

Nine distinct places gate on an OTP in this codebase. Two already had a complete, isolated
per-attempt audit trail and needed nothing new:

- **Login** — `otp-login` edge function writes `otp_login_audit` (outcome: success/failed/
  no_account/error) on every verify attempt. Complete since inception.
- **Wallet withdrawal** — `issue-wallet-withdrawal-otp`/`verify-wallet-withdrawal-otp` write
  `wallet_withdrawal_otp_challenges` (one row per issued code) and `wallet_withdrawal_otp_events`
  (event_type: sent/resent/verified/failed/**incorrect_attempt**/submitted/submit_rejected/
  already_verified). Complete.
- **Landlord payout** — `issue-landlord-payout-otp`/`verify-landlord-payout-otp`, same shape as
  wallet withdrawal. Complete.

Everything else — **signup** (phone-only account creation), **phone update** (Settings.tsx changing
the login number), **phone collection** (`PhoneCollectionGate.tsx`, prompting users with no phone
on file), **payout-number confirmation** (`PayoutNumberChangeDialog.tsx`,
`IdentityPhotoCapture.tsx`), **National ID link consent** (`national-id-link-otp`, the sub-agent
ID-linking flow — [[project_subagent_withdraws_via_parent_linked_national_id]]), **Welile Homes
tenant verification** (`AgentWelileHomesSheet.tsx`), and **password reset** (`password-reset-sms`)
— all shared the generic `sms-otp` send/verify actions and a single `otp_verifications` table with
**no purpose/category column**, upserted per-phone (one row, overwritten on every send). There was
previously no way to attribute a send or verify to a category at all — a `purpose` field already
existed on `sms-otp`'s send action (added earlier for payout-number/National-ID-link message
wording) but was only ever used to pick SMS text, never persisted anywhere queryable.

`password-reset-sms` sends its own SMS directly (doesn't call `sms-otp`) and already tagged
`sms_delivery_log.source = 'password-reset-sms'` for sends — that part needed no new writer, just
a read in the new RPC.

## What was built

1. **`otp_usage_events`** (new table) — durable per-attempt log: `category`, `event_type`
   (`sent`/`send_failed`/`verify_success`/`verify_failed`), `phone`, `source_function`,
   `created_at`. RLS: service-role read/write, cto/ceo/super_admin/manager read.
2. **`sms-otp`** now accepts `category` on both the `send` and `verify` actions (falling back to
   the existing `purpose` field, then `'uncategorized'` — never silently mislabeled), and writes to
   `otp_usage_events` on every send/verify outcome. `logOtpUsage()` in the new
   `supabase/functions/_shared/otpUsageLog.ts` is best-effort — a logging failure never blocks an
   OTP send or verify.
3. **`national-id-link-otp`** now passes `category: "national_id_link"` on its `sms-otp` verify
   call (send already passed `purpose: "national_id_link"`, which now doubles as the category via
   the fallback).
4. **`password-reset-sms`** logs `verify_success`/`verify_failed` directly (category
   `password_reset`) around its own inline OTP check in the `verify-and-reset` action.
5. **`useOtpVerification.ts`**'s `verifyOtp` now accepts an `extra` object and forwards it, mirroring
   `sendOtp` (which already forwarded `extra`). Every call site that sends or verifies a generic OTP
   now tags a category: `Auth.tsx` (login via `loginOtp`, signup via the phone-only account step),
   `TenantDashboardLandingPage.tsx` (login), `MerchantRegister.tsx` (signup), `Settings.tsx`
   (phone_update), `PhoneCollectionGate.tsx` (phone_collection), `IdentityPhotoCapture.tsx` /
   `PayoutNumberChangeDialog.tsx` (payout_number, verify leg — send already had it via `purpose`),
   `AgentWelileHomesSheet.tsx` (welile_homes_tenant_verify, raw `functions.invoke` calls),
   `BusinessAdvanceTrack.tsx` (business_claim). `useLandlordOtp.ts` has an unused "legacy" generic
   sendOtp/verifyOtp pair with no call sites left — left untagged; if it's ever wired up again it
   falls into `uncategorized` rather than being silently mislabeled.
6. **`get_otp_usage_by_category(p_date date)`** (new RPC, SECURITY DEFINER, same
   cto/ceo/super_admin/manager/service_role/anon-null guard as the other CTO RPCs) — rolls up
   `otp_usage_events` by category, UNIONed with `otp_login_audit` (category `login`, verify only),
   `wallet_withdrawal_otp_challenges`/`_events` (category `wallet_withdrawal`), the equivalent
   landlord tables (category `landlord_payout`), and `sms_delivery_log` filtered to
   `source = 'password-reset-sms'` (category `password_reset`, send only). **Verified against live
   data before writing the filter**: `wallet_withdrawal_otp_events`/`landlord_payout_otp_events`
   event_type is `incorrect_attempt` for a wrong code, not `failed` — `failed` alone would have
   undercounted verify failures by roughly 10x (153 landlord `failed` vs 178 `incorrect_attempt`,
   1 vs 10 on wallet).
7. Added to `critical_function_baselines` alongside the other three CTO RPCs
   ([[project_critical_function_drift_detection]]) — applied live in the same session.
8. New **Section 36, "OTP Usage by Category"**, added to `daily-cto-report/index.ts`'s tech report
   (the `daily-cto-report-tech` cron job runs `0 21 * * *` UTC = 00:00 EAT — this **is** "end of
   day"). One row per category: sent / send failed / verified / verify failed. A note appears under
   the table if any row lands in `uncategorized`, pointing at the fix (pass `category` to `sms-otp`).
   Also added a one-line OTP summary to the plain-text digest. The board memo (condensed weekly
   memo) was deliberately left untouched — this is an operational/engineering metric, not a
   board-level KPI, and the board template is a separate, hand-rolled PDF/HTML path.

## Applied live

`CREATE TABLE otp_usage_events` + its RLS policies, `CREATE FUNCTION get_otp_usage_by_category`,
and the `critical_function_baselines` insert all went through directly against production in this
session (unlike the two pending CTO-report migrations in doc 79 — new-table and new-function DDL on
a table nothing else touches was not blocked by the classifier the way `CREATE OR REPLACE` on an
existing, already-relied-upon function is). **The edge function code
(`sms-otp`, `national-id-link-otp`, `password-reset-sms`, `daily-cto-report`) and every frontend
call site still need a real deploy/build** before any of this shows real numbers — until
`sms-otp` is redeployed, every send/verify still runs the pre-instrumented code and
`otp_usage_events` stays empty. Same blocker as doc 79: no `SUPABASE_ACCESS_TOKEN` GitHub secret,
so the manual deploy workflow can't push edge function code yet. `sms-otp` and `daily-cto-report`
are already valid choices in that workflow; `national-id-link-otp` and `password-reset-sms` are
not — add them (mirroring the `EXPECT_PUBLIC=no` default; neither is cron-invoked) before trying to
deploy either.

## Verify once deployed

```sql
select * from get_otp_usage_by_category(current_date);
-- expect at least 'login' and whichever category you just exercised end-to-end;
-- 'uncategorized' should stay at zero going forward

select b.function_signature,
       b.expected_sha256 = encode(sha256(convert_to(pg_get_functiondef(b.function_signature::regprocedure), 'UTF8')), 'hex') as baseline_matches_live
from critical_function_baselines b where b.function_signature = 'get_otp_usage_by_category(date)';
-- expect true
```

## What not to do

- Don't add a new OTP flow anywhere in the app without passing `category` (or reusing `purpose`) on
  both the `sms-otp` send AND verify calls — the fallback to `'uncategorized'` is a safety net, not
  a substitute for tagging a new flow properly.
- Don't fold `otp_login_audit`, the wallet/landlord challenge+event tables, or
  `sms_delivery_log`'s `password-reset-sms` rows into `otp_usage_events` as a "cleanup" — the RPC
  reads them directly on purpose, so there is exactly one source of truth per category instead of
  two copies that can drift apart.
