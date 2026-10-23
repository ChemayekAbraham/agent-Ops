# Standing order amount changes — development-only report

## Result

Implemented increase/decrease controls with current amount, proposed amount, difference, reason, review and separate confirmation. After a successful save, the dialog displays the server-returned revised amount. Existing standing-order reads include `updated_at` for stale-version protection.

The new `standing_order_set_amount` operation locks and reads the current configuration, checks the existing enabled CFO/super-admin roles and `staff_mfa_ok()`, validates the amount and reason, updates only `amount` (the existing timestamp trigger maintains `updated_at`), and inserts its audit record in the same transaction. Any audit failure aborts the whole operation. No exception-swallowing lifecycle audit helper is used.

The amount must be finite, greater than zero, at most UGX 500,000,000, and different from the current amount. The upper bound matches the existing execution handler, not its obsolete UGX 50,000,000 message. The reason must contain 10–1000 trimmed characters. Both the expected amount and exact update timestamp must still match.

## Isolation and production status

- SQL is an **unapplied proposal** at `docs/pending-migrations/standing_order_amount_edit.sql`, not a production migration.
- It was executed only in disposable PostgreSQL with a private `/tmp` Unix socket and no TCP listener, cron, automatic payer, production credentials or production records.
- The preview still connects to external production Supabase. Authorized CFO/super-admin users may open and review Increase/Decrease controls, but confirmation is disabled there. The mutation independently requires development mode **and a localhost backend** before making any request.
- No production migrations, settings, financial writes, publishing, pushes or edge-function deployment were performed. Production inspection was SELECT-only.
- `process-scheduled-payouts`, `cfo-direct-credit`, scheduling helpers and historical run behavior were not modified.

## Tests

- **27 local PostgreSQL assertions passed:** increases/decreases preserve all non-amount/version configuration fields; audit retains old/new/difference/user/time/reason; signed-out, tenant, disabled CFO and insufficient MFA reject; invalid/nonfinite/null/out-of-range amounts reject; reason and stale-version checks reject; injected audit insertion failure rolls back both amount and timestamp; anonymous execution is denied; super-admin can save the upper boundary; all wallet bucket, ledger and historical-run snapshots remain unchanged; exactly one audit entry per successful edit.
- **5 focused control tests passed:** increase/decrease require explicit confirmation; only the atomic configuration operation is called; cancellation saves nothing; stale rejection makes no fallback writes or retries; the production-connected preview is blocked before sending any request.
- **2 local integration tests passed:** confirmed Increase and Decrease actions execute the actual PostgreSQL operation, display its returned amount, read back configuration/audit and verify unchanged schedule/financial snapshots. Each ends in rollback. The test bridge substitutes only the transport; authorization inputs and profiles are synthetic local fixtures, not a hosted user session.
- **11 existing schedule tests passed.**
- `npm run guard:all` passed. Preview compilation reported `build OK`.
- Local integration tests run through `bash scripts/test-standing-order-amount.sh`; ordinary focused tests run through `bunx vitest run src/test/standingOrderAmount.test.tsx src/lib/standingOrderSchedule.test.ts`.

## Exact files in scope

1. `docs/pending-migrations/standing_order_amount_edit.sql` — proposed transactional server operation and amount-edit audit action.
2. `src/hooks/useStandingOrderAmount.ts` — local-only operation, no fallback writes or automatic retries.
3. `src/hooks/useStandingOrders.ts` — include the existing update timestamp in the returned row.
4. `src/components/cfo/StandingOrderAmountDialog.tsx` — increase/decrease, review, confirmation, errors and saved-amount display.
5. `src/components/cfo/StandingOrdersPanel.tsx` — authorized entry control/dialog; hosted destinations are preview-only, with no saving.
6. `scripts/test-standing-order-amount.sh` — disposable PostgreSQL runner.
7. `scripts/fixtures/standing-order-amount-local.sql` — synthetic relevant schema/auth and protected financial sentinels.
8. `scripts/fixtures/standing-order-amount-tests.sql` — transactional safety and rejection assertions.
9. `src/test/standingOrderAmount.test.tsx` — control/transport safety tests.
10. `src/test/standingOrderAmount.integration.test.tsx` — actual local SQL operation plus UI/readback tests.
11. `AGENTS.md` — configuration-only architecture rule.
12. `roadmap.md` — scoped completion and production-approval blocker.
13. `docs/standing-order-amount-development-report.md` — this report.

Project memory also records the user's permanent configuration-only restrictions. No generated Supabase types, migration-folder files or payment-execution files were edited.

## Remaining risks and approval boundary

1. A payment already in progress may finish using the amount it captured earlier. Future scheduled reads use the revised amount, exactly as approved; no schedule is advanced by saving.
2. The existing timestamp trigger uses `now()`. Amount plus timestamp checks prevent ordinary stale edits, including same-amount changes across separate transactions; they are not a separately maintained monotonic revision counter. Row locking serializes competing configuration saves. The final review below exercises payer interleavings using the unchanged source with fully intercepted external services and a disposable database.
3. Existing direct table-update permissions and the old best-effort pause/resume audit remain unchanged. This feature's atomic operation guarantees its own audit; it does not retrofit auditing onto every pre-existing administrative write.
4. The isolated fixture covers the verified relevant schema and helpers, not a complete hosted Supabase stack. Production trigger/policy drift must be checked again immediately before any approved application. Hosted authenticated browser testing was not performed.
5. Existing other screens may need a separate presentation change to label the new `amount_edit` audit action. Its complete record is retained server-side; this task does not restyle unrelated audit viewers.
6. Production activation remains blocked pending explicit approval. Activation would require applying the reviewed SQL and deliberately changing the local-only release gate; neither has been done or requested automatically.

## Final pre-production safety review — 2026-10-23 UTC

**Verdict: isolated configuration/audit and captured-amount concurrency checks pass; NOT cleared for production activation.** No production editing, migration, deployment, payer invocation or data modification occurred. Hosted inspection was read-only catalog/configuration SELECTs. Only test tooling, this report and the task list changed during this review; proposed SQL, application controls and execution functions were left unchanged.

### Isolation and limits of the evidence

The existing runner creates disposable PostgreSQL on a private `/tmp/standing-order-db.*` Unix socket, with `listen_addresses=''`. It loads synthetic records and the pending SQL, not production data or credentials, and removes the database on exit. No hosted test project, Docker or local Supabase Auth stack is available here.

New `scripts/standing-order-preproduction-review.ts` loads the **unchanged** `process-scheduled-payouts/index.ts` into an isolated VM. Database configuration reads/updates use separate real PostgreSQL sessions. Direct-credit HTTP requests, run inserts, treasury checks and messaging are intercepted before source execution; the only allowed HTTP destination is a synthetic `.invalid` address and no real network request is sent. Payment payloads and new run records exist only in memory. Existing historical runs, wallets and ledger have write-rejecting sentinel triggers and before/after comparisons. The test harness, not an amount edit, resets synthetic due dates between scenarios.

This proves the repository payer's captured-amount and schedule-update interaction, **not** deployed-edge parity, a real payment, real hosted JWT verification, MFA enrollment/challenge, or the complete financial execution pipeline. Those remain explicitly unverified. Synthetic claim replay is not described as hosted authenticated verification.

### Hosted authorization / MFA findings

Read-only live catalog checks confirmed:

- `standing_order_set_amount` is still absent; the audit action constraint still permits only create/pause/resume/cancel. Production amount editing has not been activated.
- `has_role(uuid, app_role)` is SECURITY DEFINER with `search_path=public` and requires `user_roles.enabled=true`, matching the isolated helper.
- `staff_mfa_ok()` is SECURITY DEFINER with `search_path=public`; its live body matches the isolated helper. It enforces `aal2` for CFO/super-admin in `all` and `admin` modes, but returns true in other modes.
- **Hosted `staff_mfa_config.mode` is `shadow`. Therefore current authorization does not require a second-factor challenge for a valid CFO/super-admin.** Calling `staff_mfa_ok()` preserves existing behavior; it does not independently enforce MFA. No MFA configuration was changed.
- Both tables have restrictive `mfa_required_for_staff` policies. Existing scheduled configuration writes are permitted to enabled CFO/super-admin; audit insert policy checks the caller identity. The proposed SECURITY DEFINER function bypasses table RLS and therefore explicitly repeats role and MFA checks itself. It grants execution to authenticated/service_role and revokes PUBLIC/anon; service_role without an eligible `auth.uid()` is still rejected by the function.
- The only live UPDATE trigger on configuration is `update_updated_at_column`, which sets `updated_at=now()`. `trg_snap_lunch_allowance_next_run` is BEFORE INSERT only, not UPDATE. No live audit trigger was returned by the catalog query. The configuration columns match the fixture. Live audit also has an actor foreign key to `auth.users`, absent from the synthetic fixture; any such insert failure follows the same transaction rollback path, but that specific hosted constraint was not exercised.
- Independent active scheduled tasks exist; editing does not start them or modify their timing. No scheduled task was invoked during review.

### Evidence for each safety requirement

| Check | Evidence / result |
|---|---|
| Increase changes configuration/audit only | SQL test: UGX 100,000 → UGX 125,000; full configuration equality except amount/updated_at; matching audit. Local UI/database readback also passes. |
| Decrease changes configuration/audit only | SQL test: UGX 125,000 → UGX 75,000; same full-row comparison and negative audit difference. Local UI/database readback independently tests UGX 100,000 → UGX 75,000. |
| No payment trigger or rescheduling | Proposed function performs only amount UPDATE and audit INSERT. Existing UPDATE trigger changes timestamp only. Control tests call only this function, never table writes or edge invocation. Sentinel payer helper raises on invocation. |
| Next run, active status and schedule preserved | Full-row comparisons cover `next_run_at`, `last_run_at`, `enabled`, frequency, day-of-month/day-of-week/interval, recipient, category and creation fields; all unchanged by editing. |
| Wallets / ledger / historical runs untouched | Write-rejecting sentinel triggers plus unchanged JSON snapshots through SQL, local UI and all new concurrency/MFA cases. Synthetic payer run inserts are intercepted, not written to historical tables. |
| Atomic audit | Same transaction UPDATE + INSERT, no swallowed exception. Injected audit trigger error raises P0001 and rolls back both amount and updated_at, with prior audit rows unchanged. Exactly one audit row per successful change. |
| Failed authorization leaves no change | Original signed-out/tenant/disabled-CFO tests pass. New 45-case matrix uses actual `SET LOCAL ROLE authenticated` plus synthetic identity/AAL claims, across shadow/all/admin; every refusal returns 42501 and preserves complete configuration and audit. |
| Validation errors leave no change | 0, negative, over UGX 500,000,000, NaN, ±Infinity, null, unchanged amount, short/null/overlong reason and missing version reject with 22023; snapshots unchanged. UGX 500,000,000 accepted for authorized super-admin. |
| Stale edits leave no change | Amount mismatch and timestamp mismatch return 40001. Payer schedule update before save also causes 40001, leaving the payer's configuration intact and no edit audit. |
| Concurrent editors | Real second session waits on row lock; first commits UGX 125,000, second rejects 40001, exactly one audit. |
| Payer fetched before increase | Intercepted payer captures UGX 100,000; edit commits UGX 125,000 without advancing schedule or creating run history. In-flight synthetic payment/history retain UGX 100,000; payer's later schedule-only update preserves UGX 125,000. |
| Payer reads while decrease uncommitted | Payer sees old committed UGX 100,000, not uncommitted UGX 75,000. Its schedule UPDATE demonstrably waits on the edit's real row lock, then preserves UGX 75,000 after commit. |
| Future independently scheduled read | Later due fetch uses committed UGX 125,000 for payment payload and synthetic run record. It is the fetch boundary, not payment completion time, that selects the amount. |
| Production disabled | Five control tests include hosted URL rejection before any request. Gate still requires DEV and loopback backend. Proposed function remains absent live. |

### Re-run results

- `bash scripts/test-standing-order-amount.sh`: **27 SQL assertions + 2 UI/PostgreSQL integration tests + 9 final-review groups passed**. The latter contain **45 authorization/MFA cases**, four actual-source payer interleavings, concurrent editors and financial snapshot checks.
- `bunx vitest run src/test/standingOrderAmount.test.tsx src/lib/standingOrderSchedule.test.ts`: **16/16 passed** (5 controls, 11 schedule regressions).
- `npm run guard:all`: **all guards passed**.
- A first attempt in the new harness safely rejected an authorized edit as stale because the PostgreSQL driver normalized a timestamptz parameter to millisecond precision. The test bridge now sends the original timestamp as text before the server cast. Production hook already passes the original timestamp string unchanged; no application or SQL correction was needed. Never normalize that version through a JavaScript Date.

### Unresolved risks / release blockers

1. **Real hosted Auth/MFA end-to-end remains unverified.** A separately isolated hosted/staging stack with synthetic users, real signed JWTs and MFA enrollment/challenges is required for that claim. Do not use production records or payments for this test.
2. **Shadow mode means MFA is not enforced today.** Separately decide whether preserving shadow behavior is acceptable or whether this operation must require AAL2. Any operation-specific AAL2 requirement or global MFA mode change needs separate approval; global mode changes could affect other staff workflows.
3. **Existing payer race is outside this change.** Source performs success lookup → credit → history → schedule in separate operations, with no visible atomic cycle claim. Overlapping workers, or credit success followed by failed history/schedule persistence, may expose duplicate execution. This review does not prove global payer idempotency or change its behavior. Deployment gateway authentication and deployed constraints still need independent verification before making any stronger claim.
4. Timestamp is not a monotonic version. Locking and stale checks pass separate-session tests; multiple return-to-original edits within one transaction can share `now()` and create an ABA version ambiguity. UI uses separate requests and does not perform such batching. Other direct configuration writers and the old best-effort lifecycle audit remain unchanged.
5. Existing direct administrative table-update access can bypass this feature's atomic audit. The guarantee covers only `standing_order_set_amount`; tightening old access is a separate permission change, not part of activation.
6. Localhost is an accident-prevention release gate, not proof a proxy cannot point at production. This review used a private disposable database with no proxy. A future isolated hosted test destination needs its own explicitly approved gate/configuration.

### Exact production changes requiring separate approval

**None performed.** Minimum proposed activation consists of:

1. Re-check live schema, UPDATE/audit triggers, policy restrictions, helper definitions, ownership and function/table privileges immediately before application; validate hosted staging Auth/MFA first.
2. Apply the exact reviewed `docs/pending-migrations/standing_order_amount_edit.sql` via the approved migration process: expand only `standing_order_audit_log_action_check` with `amount_edit`; create `standing_order_set_amount(uuid,numeric,timestamptz,numeric,text)`; revoke PUBLIC/anon execution and grant authenticated/service_role execution. No new tables or financial writes, no payer changes, no scheduler changes.
3. Separately approve a frontend release-policy change in `src/hooks/useStandingOrderAmount.ts` so approved production builds can expose/use the existing amount controls. `StandingOrdersPanel` consumes that same gate; server authorization and no-retry/no-fallback behavior must remain. Applying SQL alone does not activate the controls.
4. If mandatory AAL2 is desired despite shadow mode, approve an explicit authorization amendment separately; do not silently change global MFA settings.
5. Approve publishing that frontend change separately. **No** `process-scheduled-payouts` or `cfo-direct-credit` deployment, financial backfill, wallet/ledger update, historical-run change or scheduled-task adjustment is required by this feature.

No approval to apply or activate is requested automatically; resolve the above evidence gaps and MFA decision before a separate release decision.

### Production approval preparation — 2026-10-23 UTC

The current approval package and step-by-step activation/rollback plan are in `docs/standing-order-amount-production-approval.md`. This supersedes historical control counts and descriptions above: **7 control tests + 11 schedule tests = 18 passed**, plus **2 local integration tests**, **27 SQL assertions**, and **9 concurrency/MFA review groups containing 45 authorization cases**. All guards passed again. The exact proposal and both payment handlers remain unchanged.

Fresh SELECT-only hosted checks still find no amount-edit function, the original four-action audit constraint, `staff_mfa_config.mode=shadow`, enabled-role checks, and only the timestamp UPDATE trigger. Effective privilege checks confirm existing authenticated table UPDATE access; the empty `role_table_grants` result was not used to infer missing access. Hosted signed-JWT/MFA end-to-end verification remains blocked by the absence of an isolated hosted test environment. No application code, SQL proposal, production configuration or production data changed during this preparation.

### Files changed by this final review only

1. `scripts/standing-order-preproduction-review.ts` — isolated authenticated-role/MFA matrix and unchanged-source payer concurrency harness.
2. `scripts/test-standing-order-amount.sh` — invokes the new harness in its existing disposable database.
3. `docs/standing-order-amount-development-report.md` — this evidence, limitations and approval boundary.
4. `roadmap.md` — final review and explicit hosted verification blocker.