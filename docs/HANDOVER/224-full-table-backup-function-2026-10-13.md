# 224 — full-table-backup: every public table, paged and verified (2026-10-13)

**Status: WRITTEN, NOT DEPLOYED, NOT RUN END-TO-END.** Only the pure parts were tested (CSV record counting, table list vs live
database by md5 — see below). The paging, upload and self-chaining logic has never executed; there is no Deno on the author's
machine. Treat the first run as a test, on a small subset.

Driver: PDPO request. The weekly `weekly-database-backup` holds 91 of 860 tables and ~1,000 rows each (doc 141, HANDOVER/05).
Option B of the backup discussion ("extend the ledger-style paging to every table"). Option A (off-platform encrypted
`pg_dump`) is still a plan only: `docs/pending-changes/offsite-full-database-backup-plan-2026-10-13.md`.

## What it does
`supabase/functions/full-table-backup` — manual trigger only (no cron), manager or cto role, or the service key (used by its own chain).
- Exports every base table in `public` (860; list in `_shared/fullBackupTables.ts`) as CSV, paged 1,000 rows at a time ordered by
  primary key (limit/offset, four pages in parallel), split into ≤40 MB parts.
- Counts the records it actually wrote and compares with the table's row count taken just before. A mismatch is reported
  (`count_mismatch`), not hidden. (The weekly job's `row_count` was the table total, not what was written.)
- One run is a chain of invocations (~100 s each) that POST their state to themselves; resumable at part boundaries.
- Output: `db-backups/full_tables/<year>/<timestamp>/<table>/<table>_partNNN.csv`, plus `manifest.json` and a `backup_runs` row
  with `backup_kind='full_tables'` (status success / partial / failed). No email, no signed link.

## What it does NOT cover (also written into every manifest)
- `auth.users` — login accounts. Needs the admin API; not built.
- Storage file contents (ID photos, selfies, receipts, HR documents). Needs a separate copy job.
- Schema, functions, policies, triggers.
- Tables created after the list was generated (2026-10-13). Regenerate with the SQL in the file header.
- Tables with no primary key (4): `evidence_2026_08_13_field_audit`, `ledger_balance_pivot_2026_08_01_backup`,
  `tppo_period_snapshots_archive`, `wallet_backup_2026_04_17` — reported `skipped_no_pk`.
- **Deliberately excluded credential tables (12):** `staff_access_passwords`, `hr_pay_bank_secrets`, `agent_form_tokens`,
  `payment_tokens`, `portfolio_completion_tokens`, `email_unsubscribe_tokens`, `otp_verifications`, `user_2fa_challenges`,
  `landlord_payout_otp_challenges`, `phone_change_otp_challenges`, `wallet_withdrawal_otp_challenges`, `rent_renewal_otps`.
  A leaked backup must not hand over live secrets; reissue them after a restore. Edit `EXCLUDED_SECRET_TABLES` to change.
- Not a point-in-time snapshot: a table written to during the run can drift (flagged as `count_mismatch`).

## Verified
- CSV counter handles quoted newlines, escaped quotes, missing trailing newline (Node test, 8 cases).
- Embedded table list == live catalogue: md5 `867d1addebac98ab3f8c209c40b78050` over 23,116 chars, identical in SQL and in the file.
- 860 readable tables by `service_role`, no partitions, 113 views excluded (checked 2026-10-13).

## Before the first real run
1. Deploy the function (Lovable). No `config.toml` change; default JWT verification stays on.
2. Test on a subset first: POST `{"tables":["ledger_account_catalog","staff_profiles"]}` as manager/cto; read `manifest.json`.
3. **Storage:** a full run writes roughly 3-4 GB of CSV into `db-backups` (database is 5.4 GB). There is no retention rule, so do not
   run it repeatedly until one exists. Large-table offsets also cost database time: run outside payout hours.
4. Do a restore drill from one table's CSV into a throwaway project before calling this a backup.

## Open
- No cron, no failure alert, no email (a silent failed backup is the same as no backup) — add after the first successful run.
- No retention, no encryption beyond platform at-rest, same project as production (Option A addresses all three).
