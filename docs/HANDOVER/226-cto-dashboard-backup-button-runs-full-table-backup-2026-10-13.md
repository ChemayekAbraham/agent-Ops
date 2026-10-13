# 226 — CTO dashboard "Run backup now" now runs the full-table backup (2026-10-13)

**Status: BUILT, NOT DEPLOYED, NOT RUN.** Depends on doc 224 (`full-table-backup`), which has never run in production
(live check 2026-10-13: zero `backup_runs` rows with `backup_kind='full_tables'`).

## Problem
`RunBackupNowButton` (CTO dashboard and admin Dashboard) invoked `weekly-database-backup`, which holds 91 of 860 tables and
the first ~1,000 rows of each (PostgREST row cap).

## Change
- `src/hooks/useFullDatabaseBackup.ts` (new): invokes `full-table-backup` (returns 202 + `folder`), then polls every 15 s
  until the run's `backup_runs` row exists; gives up polling after 3 h (the run itself continues).
- `supabase/functions/full-table-backup`: new `{action:"status", folder}` (manager/cto only, folder format validated).
  `backup_runs` is readable by `manager` only (RLS), but the function admits `cto` too, so status is read server-side.
  No migration.
- `RunBackupNowButton.tsx`: handler/state only. The result panel no longer shows a download link (guarded on
  `signedUrl`): full-backup output stays private in `db-backups`, no emailed link (consistent with doc 223).

## Known gaps / hand-back to UI (Gemini)
- Panel copy still says "typical 30-90s", "Generating dump, uploading, and signing link" and "Rows"; a full run takes far longer.
- No per-table progress; only started/finished.
- No download path for the CSVs yet (needs a signed-URL action or a restore tool). Not covered by this backup: `auth.users`,
  Storage files, schema/functions (see doc 224).
- "Resend link" still re-sends the latest weekly (capped) backup and is now misleading next to the new button.

## Before first use
1. Deploy `full-table-backup` (Lovable). Merge to `lovable` only when its agent is idle and Josh approves.
2. First run as a subset via the hook: `start(['ledger_account_catalog','staff_profiles'])`; read `manifest.json`.
3. A full run writes ~3-4 GB CSV into `db-backups` and there is no retention rule: do not repeat it. Run outside payout hours.
4. Restore drill into a throwaway project before calling it a backup.

## Verified
`npm run guard:all` passes. ESLint on the touched files: only pre-existing `no-explicit-any` errors in `handleResend`.
`tsc` cannot complete locally (OOM), so types are unchecked beyond lint.
