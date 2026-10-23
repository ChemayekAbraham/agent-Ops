# Standing order amount changes — development-only report

## Result

Implemented increase/decrease controls with current amount, proposed amount, difference, reason, review and separate confirmation. After a successful save, the dialog displays the server-returned revised amount. Existing standing-order reads include `updated_at` for stale-version protection.

The new `standing_order_set_amount` operation locks and reads the current configuration, checks the existing enabled CFO/super-admin roles and `staff_mfa_ok()`, validates the amount and reason, updates only `amount` (the existing timestamp trigger maintains `updated_at`), and inserts its audit record in the same transaction. Any audit failure aborts the whole operation. No exception-swallowing lifecycle audit helper is used.

The amount must be finite, greater than zero, at most UGX 500,000,000, and different from the current amount. The upper bound matches the existing execution handler, not its obsolete UGX 50,000,000 message. The reason must contain 10–1000 trimmed characters. Both the expected amount and exact update timestamp must still match.

## Isolation and production status

- SQL is an **unapplied proposal** at `docs/pending-migrations/standing_order_amount_edit.sql`, not a production migration.
- It was executed only in disposable PostgreSQL with a private `/tmp` Unix socket and no TCP listener, cron, automatic payer, production credentials or production records.
- The preview still connects to external production Supabase. Both the controls and mutation reject that destination: development mode **and a localhost backend** are required.
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
5. `src/components/cfo/StandingOrdersPanel.tsx` — local-only authorized entry control/dialog.
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
2. The existing timestamp trigger uses `now()`. Amount plus timestamp checks prevent ordinary stale edits, including same-amount changes across separate transactions; they are not a separately maintained monotonic revision counter. Row locking serializes competing configuration saves. Concurrent payer interleavings were not exercised because that execution pathway must remain untouched.
3. Existing direct table-update permissions and the old best-effort pause/resume audit remain unchanged. This feature's atomic operation guarantees its own audit; it does not retrofit auditing onto every pre-existing administrative write.
4. The isolated fixture covers the verified relevant schema and helpers, not a complete hosted Supabase stack. Production trigger/policy drift must be checked again immediately before any approved application. Hosted authenticated browser testing was not performed.
5. Existing other screens may need a separate presentation change to label the new `amount_edit` audit action. Its complete record is retained server-side; this task does not restyle unrelated audit viewers.
6. Production activation remains blocked pending explicit approval. Activation would require applying the reviewed SQL and deliberately changing the local-only release gate; neither has been done or requested automatically.