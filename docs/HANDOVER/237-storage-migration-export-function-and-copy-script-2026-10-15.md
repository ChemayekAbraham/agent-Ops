# 237. Storage export function and copy script for the PDPO migration (2026-10-15)

**Status: WRITTEN, NOT DEPLOYED.** Needs a push to `lovable` while Lovable's agent is idle, then a Lovable deploy of `storage-migration-export`.

## Why
The HR/PDPO policy requires the data to live in our own Supabase project (`byrzshwlentqvktcksem`). The database was restored from Lovable's dump. Storage files are not in a pg_dump (only `storage.objects` metadata), and we hold no service key for Lovable Cloud, so the files need a controlled export path.

## What changed
- `supabase/functions/storage-migration-export/index.ts` (new, read-only). Manager or CTO login required (same gate as `full-table-backup`).
  - `list`: one page of a folder (`bucket`, `prefix`, `offset`) -> files with size, sub-folders, `next`.
  - `sign`: up to 200 paths -> signed download URLs (default 30 min, max 6 h). Logs the actor.
  - Refuses `db-backups` and `database_export_*`. Never writes, moves or deletes.
- Local copy script (outside the repo, it holds no secrets): `C:\Users\USER\pdpo-rehearsal\scripts\storage_copy.mjs`. Reads credentials from environment variables only. `list` counts files, `copy` downloads from the source and uploads to the target with the target service key. Resumable through a per-bucket `.done` log, size-checked per file, failures written to a `.failed` file.

## Source inventory (storage.objects, 2026-10-15)
About 15.5 GB in 205k objects excluding the backup and export buckets. Largest: `payment-proofs` 5.4 GB, `house-images` 4.7 GB (195,346 files, public bucket), `lc-letters` 1.1 GB, `partner-agreements` 0.9 GB, `identity-verification` 648 MB. Personal-data buckets: `identity-verification`, `tenant-ids`, `hr-documents`, `resumes`.

## Already done on the target
32 buckets created with the source's public flag, size limits and MIME limits; the 89 `storage.objects` policies restored from the dump and verified identical to the source by hash.

## After the copy
Remove or disable `storage-migration-export` on the source once every bucket is verified (file count and bytes per bucket, target vs source).
