# Standing-order amount adjustment: production approval package

Prepared 2026-10-23 UTC. **Status: preparation complete; NOT approved or activated.**

## Decision summary

Local tests verify configuration-and-audit atomicity, rejected-edit rollback, stale-edit protection and captured-amount concurrency. Hosted catalog inspection confirms existing enabled-role authorization, but **MFA is in shadow mode and does not require a second factor today**. Real hosted signed-session/MFA testing is unavailable without an isolated hosted test environment. This package documents that gap rather than claiming it is resolved.

No production migration, setting change, editing activation, deployment, payment invocation or production data modification was performed. Only this document, the development report and the task list changed. The proposed SQL, application controls and payment handlers were left untouched.

## Exact proposal reviewed

- File: `docs/pending-migrations/standing_order_amount_edit.sql` (unapplied).
- SHA-256: `0503a512b1f4e8b527285d345489773a8a0a42466079c5526e60fff1e520ffc1`.
- Review baseline: `f1df2d221a5216f1cfc530e5ff3bdac658445413`; this is a source baseline, not a deployment approval.
- The SQL has one transaction: expand `standing_order_audit_log_action_check` to permit `amount_edit`; create `standing_order_set_amount(uuid,numeric,timestamptz,numeric,text)`; revoke PUBLIC/anon execution; grant authenticated/service_role execution; commit.
- The operation requires a signed-in enabled CFO or super-admin and `staff_mfa_ok()`. It validates finite amount > UGX 0 and <= UGX 500,000,000, a different amount, a 10–1000-character trimmed reason, and expected amount/update timestamp.
- It locks the configuration row with `FOR UPDATE`, checks both expected values, updates only `scheduled_payouts.amount`, and inserts one `standing_order_audit_log` record. The existing trigger updates `updated_at`. A full-row comparison rejects any other configuration change. There is no exception handler swallowing an audit failure.
- Audit details retain previous/new/difference, actor, audit timestamp, reason, previous/new update timestamps and `future_scheduled_runs_only`.
- It does not call a payer, a credit/debit operation or the lifecycle audit helper. It writes no payment, run, wallet or ledger table and changes no schedule, active state or next-run date.

The timestamp maintenance is the only non-amount configuration field allowed to change. No new tables, role model, scheduler, payment backfill or edge-function deployment are required.

## Fresh hosted read-only findings

SELECT-only inspection of the connected RentFlow database confirmed:

1. `user_roles.enabled` exists; `has_role` checks enabled membership using SECURITY DEFINER and `search_path=public`.
2. `standing_order_set_amount(...)` remains absent. Audit actions remain create/pause/resume/cancel.
3. `staff_mfa_config.mode` is `shadow`. `staff_mfa_ok()` enforces AAL2 for these roles in `all`/`admin` modes, but returns true in shadow mode. Missing AAL therefore does not block an eligible CFO/super-admin under the exact current proposal.
4. Both affected tables have restrictive staff MFA policies. SECURITY DEFINER bypasses their ordinary RLS enforcement, so the operation's explicit role/MFA checks are essential.
5. Configuration has one UPDATE trigger, `update_scheduled_payouts_updated_at`, whose body only assigns `NEW.updated_at=now()`. The lunch allowance schedule trigger is INSERT-only. No user-defined audit trigger was returned.
6. Effective privileges: authenticated/service_role have table SELECT/INSERT/UPDATE/DELETE privileges; anon has SELECT but no writes. RLS remains the additional access gate. Existing authenticated configuration UPDATE policy permits enabled CFO/super-admin. This pre-existing path can bypass this feature's atomic audit guarantee; this review does not broaden or remove it.
7. Audit actor references `auth.users`. The local fixture lacks that specific hosted foreign key; any insertion error must roll back transactionally, but its hosted behavior still requires staging validation.

### MFA decision requiring approval

**Preferred narrowly scoped proposal, not implemented:** require AAL2 inside this operation regardless of global shadow mode, retaining the existing role and `staff_mfa_ok()` checks. Add this fail-closed condition to the authorization rejection branch:

```sql
OR COALESCE(auth.jwt() ->> 'aal', 'aal1') <> 'aal2'
```

This is an authorization amendment and changes the SQL fingerprint. It requires separate approval, a newly reviewed/fingerprinted proposal and staging tests before application. It must use the server-verified JWT, never client storage or a client-supplied AAL parameter. It does not change global MFA configuration or unrelated workflows. An existing supported MFA challenge flow must be verified for CFO/super-admin users; if unavailable, a scoped challenge integration requires additional frontend approval. No challenge bypass is acceptable.

Other explicit choices:
- Approve the exact existing SQL while accepting that shadow mode does **not** enforce second-factor authentication; the release must not be described as MFA-enforced.
- Separately approve switching global MFA mode to `admin` or `all`. This affects other staff workflows and is not the minimal feature change. Its impact, enrollment readiness and restoration plan must be separately reviewed. Do not change the MFA-setting read access finding previously designated “leave as is.”

Real hosted Auth/MFA remains a release blocker whichever enforcement option is chosen; synthetic claim tests do not verify token validation, enrollment, challenge or session refresh.

## Re-run safety evidence

| Requirement | Evidence and result |
|---|---|
| Increase/decrease only configuration/audit | Real disposable PostgreSQL tests: UGX 100,000 → UGX 125,000 and UGX 125,000 → UGX 75,000; full-row equality except amount/updated_at and matching audit. Two UI/database readbacks also pass. |
| Atomicity | Injected audit INSERT failure rejects and restores both amount and update timestamp; existing audit snapshot unchanged. One audit per successful edit. |
| Authorization/MFA failure | Signed-out, tenant, disabled CFO and insufficient MFA reject with unchanged configuration/audit; 45 synthetic role/AAL cases across shadow/all/admin pass against current helper logic. Shadow acceptance is evidence of the gap, not enforced MFA. |
| Invalid input | Null, unchanged, zero, negative, nonfinite and over-limit amount; invalid reason and missing version reject without changes. Authorized upper limit UGX 500,000,000 passes. |
| Stale edit | Amount/timestamp mismatches reject with 40001. Payer updating the version first makes a stale save reject; no automatic retry or fallback write. |
| Concurrent editors | Separate sessions: second waits on row lock, then rejects stale version; exactly one edit/audit commits. |
| No triggering/rescheduling | Only amount UPDATE and audit INSERT in the proposal; timestamp-only hosted UPDATE trigger; control tests invoke only the amount operation. No HTTP/payment transport is invoked by saving. |
| Captured payer amount | Unchanged payer source loaded into an intercepted VM: a previously captured UGX 100,000 remains UGX 100,000 after an edit to UGX 125,000. A later independently due fetch reads UGX 125,000. |
| Uncommitted edit/payer overlap | Payer sees committed UGX 100,000 during an uncommitted decrease; its own later schedule UPDATE waits on the row lock, then preserves UGX 75,000. That schedule change belongs to the independently started test payer, not the amount save. |
| Protected fields/tables | Full configuration snapshots preserve next/last run, enabled, schedule, recipient and category. Write-rejecting sentinels and before/after snapshots preserve wallets, ledger and historical runs. Payer credit/run writes are intercepted in memory. |
| Controls cannot save on production | Seven control tests include review-only Increase/Decrease and hosted-destination rejection before any request. Panel checks active CFO/super-admin presentation; mutation independently requires DEV plus loopback backend. |

Commands/results:
- `bash scripts/test-standing-order-amount.sh`: **27 SQL assertions, 2 UI/PostgreSQL integration tests and 9 review groups (including 45 authorization/MFA cases) passed**.
- `bunx vitest run src/test/standingOrderAmount.test.tsx src/lib/standingOrderSchedule.test.ts`: **18/18 passed** (7 controls + 11 schedule regressions).
- `npm run guard:all`: **all guards passed**.

Isolation: disposable private Unix-socket PostgreSQL, no TCP listener or production credentials/data; automatic payment HTTP, treasury checks, messaging and new run inserts intercepted. The harness independently initiates synthetic payer scenarios; amount changes never initiate them. These tests establish local source behavior, not deployed payer parity or global payment idempotency.

## Deployment and activation plan — do not execute without approval

1. **Approve the staged scope and MFA policy.** Select operation-specific AAL2, accepted shadow behavior, or separately reviewed global enforcement. Authorize an isolated hosted staging environment with synthetic users/configuration. No production records or payment destinations may be copied into tests.
2. **Freeze the approved SQL.** If AAL2 is selected, amend only the pending proposal and tests after approval, re-run rejection/concurrency tests, obtain a new hash and independent review. Do not treat the hash above as approval for amended SQL. Record exact function signature, owner, grants and prior audit constraint.
3. **Validate hosted staging.** Apply the approved SQL only there under staging approval. Exercise real signed CFO/super-admin AAL1/AAL2 sessions, signed-out/anon/tenant/disabled users, service-role without eligible user identity, missing/invalid claims, MFA enrollment/challenge and refreshed session. Confirm denied attempts leave both tables unchanged. Exercise successful increase/decrease with exact readback, timestamp precision, actor FK and injected audit failure in staging. Use no live payer transport; re-run isolated concurrency tests. Retain results for release approval.
4. **Prepare a default-off frontend policy change.** Separately approved change in `src/hooks/useStandingOrderAmount.ts` replaces the unconditional DEV/loopback-only production rejection with an explicit default-off release switch scoped to the approved backend/project. `StandingOrdersPanel.tsx` must consume the same policy for preview-only versus saving; dialog confirmation remains separate. Keep no retry, no fallback table write, original timestamp string and server-returned audit/result verification. A client flag is not authorization: enabled roles/MFA remain checked by the server. Add policy tests for default-off, wrong destination, authorized staging, denied roles and server rejection. Add scoped MFA challenge handling only if staging proves it is needed. **No such code change was made now.**
5. **Production preflight, read-only.** Immediately before separately approved application, fingerprint the target RentFlow project, compare columns/types/constraints/triggers/policies/helpers/ownership/privileges and dependency lists to the staging evidence, and verify the proposal hash. Stop on drift. Save definitions/ACLs, not financial data. Verify the migration recording process is working; earlier migration-service 42P10 failures are not evidence of SQL success. Never blindly retry a partial/unknown result.
6. **Apply only approved SQL, with editing still off.** Separate production migration approval is required. Record full output and migration identity; on failure stop and verify transaction/catalog state read-only. Confirm function definition/owner/grants, no PUBLIC/anon execute, correct audit constraint and unchanged triggers. Do not call the production mutation as a smoke test under this approval package.
7. **Release frontend default-off.** Separate frontend publication approval is required. Verify authorized users can review controls but cannot save while off; unauthorized users do not acquire access. No payer or `cfo-direct-credit` deployment, cron change, financial backfill, active/next-run edit or payment invocation is part of this release.
8. **Activate only after final release sign-off.** Separately approve the specific production release switch/destination change and the agreed MFA policy after staging evidence passes. SQL application alone cannot make the controls usable. Frontend activation alone cannot authorize a save. Both must exist, with eligible server-validated identity, valid input, fresh version and confirmation. Any production amount edit, even a smoke test, needs separately authorized order/amount/reason and must not trigger a payer. Do not test using an already-due production order merely for convenience.
9. **Observe without causing execution.** Inspect errors/audit/configuration readbacks for authorized edits, verify no unexpected fields changed and monitor lock waits. Existing independently scheduled payments may occur normally; do not disable/advance/retry them to “validate” this feature. Stop further amount edits on an unexpected result; follow rollback below.

## Non-destructive rollback instructions — approval required

1. **Block new feature saves first.** For immediate server containment, separately approve revoking EXECUTE on this exact operation from PUBLIC, anon, authenticated and service_role. Retain a function owner that is not an application login. Revoke blocks subsequent requests, not a transaction already executing. Inspect in-flight activity before claiming containment is complete; do not terminate payer sessions.
2. **Restore frontend review-only policy.** Restore the prior DEV/loopback-only gate or the release switch to off and publish only with rollback publication approval. Do not roll back unrelated concurrent UI changes or weaken server role/MFA checks. Frontend-only rollback is insufficient to block clients already loaded with the enabled release.
3. **Keep all committed amounts and audits.** Feature rollback does not restore old configured amounts. Doing that would modify production configuration and future payment amounts; any correction requires a separately approved audited amount change. Never delete/modify amount-edit audit rows, historical runs, wallets or ledger entries, and never reschedule or reverse a payment.
4. **Leave the expanded audit constraint in place after any successful amount edit.** Restoring the old four-action CHECK would reject retained `amount_edit` rows. A safe disable rollback retains the expanded CHECK and immutable evidence. Only if read-only verification proves no such rows exist and no requests remain may a separately approved schema rollback restore the old CHECK transactionally.
5. **Optional removal of the disabled operation.** After dependency and in-flight checks, separately approve dropping the exact function with RESTRICT, never CASCADE. Keeping it installed with revoked application execution is the least destructive rollback. Future recreation requires explicit grants and a new review.
6. **Application failure before commit.** The proposal's BEGIN/COMMIT transaction should leave the prior schema intact on failure. Confirm catalog state and migration history before any retry; do not modify financial data to repair migration bookkeeping.
7. **If a global MFA-mode change was separately made**, its restoration needs its own authorization and security impact review. Do not automatically relax global MFA as part of disabling amount editing. The operation-specific AAL2 option needs no global-setting rollback.

## Remaining risks and approvals required

- **Unavailable environment:** no isolated hosted Auth/MFA stack or credentials were provided; real JWT/MFA/FK end-to-end evidence is still missing. Approval to provision/use that staging environment is required before release clearance.
- **MFA policy:** explicitly approve the narrow AAL2 amendment or explicitly accept shadow behavior; do not silently change global staff settings.
- **Existing direct UPDATE access:** atomic audit and any operation-specific MFA guarantee apply to this operation, not every pre-existing administrative writer. System-wide prevention of bypass would need separately approved permission/RPC redesign; it is not included here.
- **Timestamp version limitation:** `now()` is transaction-based, not monotonic. Separate-request concurrency passes; multiple return-to-original edits in one transaction can share a timestamp (ABA). Preserve timestamp text without JavaScript Date normalization. A revision-counter redesign is separate scope.
- **Existing payer race:** lookup, credit, run insert and schedule update are separate operations. This feature does not prove/fix overlapping-worker idempotency or persistence failures. Captured amounts may finish at the old value, as approved. Deployed source parity remains unverified.
- **Isolation gate:** loopback is accident prevention, not a proxy-proof boundary. Staging must have positively verified project isolation and intercepted payment transports.
- **Three distinct release approvals:** final SQL/authorization approval; production migration application approval; frontend release/activation/publication approval. Any production test edit requires its own authorized amount/reason. None is supplied by this preparation request.

**Stop point:** retain review-only controls, unchanged SQL and unchanged production. Resolve staging evidence and the MFA decision before requesting final activation approval.