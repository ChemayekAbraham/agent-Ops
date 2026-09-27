# 141: Dedicated general_ledger backup, emailed to Josh

**Status (2026-09-27):** migration `20260927160000` has been **applied live** (verified: the RPC returns 624,989 rows and 694 boundaries, anon cannot execute it, and `backup_runs.backup_kind` exists). Edge functions `general-ledger-backup` and `resend-database-backup-link` (changed) still need to be **deployed**. The nightly cron migration `20260927160100` stays **unapplied** until a manual run has been verified.

## Read this first: the weekly "full" backup never held the ledger

`weekly-database-backup` records `success` every Sunday, but PostgREST caps each response at **1000 rows**, and that function reads each table in a single request. The `Content-Range` total it logs as `row_count` is the table's full size, not what was written. The evidence:

- the 2026-09-27 run reports 91 tables and 2,360,415 rows, yet the file is **11.3 MB** and was written in about 5 seconds;
- general_ledger alone is 624,989 rows and 1.1 GB on disk.

So every weekly backup holds only the **first 1000 rows of each table**. `05-disaster-recovery.md` said it was "genuinely working". It isn't, and this doc does not fix it for the other 90 tables.

## What was built

- **RPC** `general_ledger_backup_boundaries(p_step)`: service_role only and read-only. It returns `{total, boundaries[]}`, which is the id at every 900th row in id order (about 0.4 s).
- **Edge function** `general-ledger-backup` works like this:
  - Pages `general_ledger` by `id > prev AND id <= next`.
  - Keeps up to 6 pages in flight and writes them in id order.
  - Any range holding more than 1000 rows (new postings) is read to its end.
  - The last range is open-ended.
  - Output is CSV with one header per part, split into parts of about 40 MB each under `db-backups/general_ledger/<year>/<stamp>/`, alongside a `manifest.json`.
  - Status is `success` only when exported rows are at least the count taken at the start (the ledger is append-only).
  - Logs to `backup_runs` with `backup_kind='general_ledger'`.
  - Emails 7-day signed links. A failure or incomplete run also emails, with an INCOMPLETE subject.
  - Body `{"skipEmail": true}` runs it without sending the email.
- **Template** `general-ledger-backup-ready`: its recipient is **fixed** to `joshwanda17@gmail.com` through the template `to`, whoever calls it.
- **`backup_runs.backup_kind`** (default `full_database`): `resend-database-backup-link` now filters on it, so "resend latest backup" can never send a ledger manifest as the full backup.
- **Cron** `general-ledger-backup-0100-eat` runs at `0 22 * * *` UTC, which is 01:00 EAT.

## Restore

For each part: `\copy public.general_ledger FROM 'general_ledger_partNN.csv' WITH (FORMAT csv, HEADER true)`. Check the total against `manifest.json`.

## Verify

```sql
SELECT created_at, status, row_count, size_bytes, error_message
FROM public.backup_runs WHERE backup_kind = 'general_ledger' ORDER BY created_at DESC LIMIT 5;
```

## Open

- The full-database backup still takes only the first 1000 rows of every table. It needs the same paging, or better a real `pg_dump`/PITR off-platform (see 05).
- Worker limits: the first run measures the wall time. If it approaches the edge limit, raise `CONCURRENCY` or split the run.
