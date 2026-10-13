# PLAN (nothing built, nothing run): off-platform full database backup — 2026-10-13

Why: the weekly `weekly-database-backup` is a partial export (91 of 857 tables, ≤~1,000 rows each, no auth users, no files;
see docs 141 and HANDOVER/05). PDPO needs an honest backup statement. Doc 05 already says: confirm managed backups,
get backups off-platform, add schema, do a restore drill. This plan covers steps 1-2.

## Step 1 — Read the managed backup settings (a person with Supabase/Lovable Cloud owner access, ~10 min)
Project ref `wirntoujqoyjobfhyelc` (owner per doc 01: weliletenants@gmail.com). Dashboard → Database → Backups. Record:
- [ ] Plan tier
- [ ] Daily backups on? Retention in days:
- [ ] Point-in-time recovery (PITR) on? Window:
- [ ] Date/time of the latest backup:
- [ ] Project region (Settings → Infrastructure):
- [ ] Are storage objects (ID photos etc.) included? (Supabase database backups do NOT include Storage files.)
Paste the answers into the PDPO draft §2 Backups. If daily backups + PITR are on and retention is adequate, Step 2 is
an additional safeguard; if not, it is the primary one.

## Step 2 — Off-platform encrypted dump (only after the decisions below)

### Decisions needed from Josh / CEO (code cannot make these)
1. **Destination — DECIDED 2026-10-13 (Josh): the separate Supabase project `fqvgfkqxykaxzndhbaps`** (private Storage bucket).
   CONFIRMED by Josh 2026-10-13: owner `weliletenants@gmail.com` (SAME login as production — fails requirement (a); one compromised
   login reaches both copies, so move ownership to a separate account or add a different owner before any data goes in),
   region eu-west-1 (Ireland), project already has tables (contents unknown — inspect before use), public sign-up was open
   (`disable_signup:false`, checked 2026-10-13 from outside) and must be switched off.
   Still to confirm: (a) which account owns it and that it is NOT the same account/login as production, (b) its region
   (Settings → Infrastructure), (c) the bucket is private with no public policy, (d) who has access. It is a new PDPO entry
   (a copy of ALL personal data), and it is still Supabase, so it protects against losing the production project, not
   against a Supabase-wide or account-level incident. Upload with that project's SERVICE-ROLE key stored as a GitHub secret
   (`BACKUP_SUPABASE_URL`, `BACKUP_SUPABASE_SERVICE_KEY`); the anon key shown in the dashboard cannot and must not be used.
   Never paste either key into chat, git or docs.
2. **Encryption key holder.** Dump is encrypted before it leaves the runner (age or gpg). Name two people who hold the key;
   lose the key = no backup.
3. **Database credential.** `pg_dump` needs a database connection string/password. Handover doc 01 says it is inaccessible by
   design; an owner must reset it in the dashboard and store it as a GitHub secret. Use a read-only role if one can be created.
4. **Retention.** Suggested: 14 daily + 8 weekly, older deleted automatically. Confirm.
5. **Who is alerted** if a run fails (a silent failed backup is the same as no backup).

### Design (draft; keep OUT of .github/workflows until decisions 1-5 are made)
- Trigger: `schedule` nightly + `workflow_dispatch`.
- Steps: install postgres client matching server major version → `pg_dump --format=custom --no-owner` (public schema, plus
  `auth` and `storage` schemas so login accounts and file metadata are included) → `age -r <public key>` → upload to destination
  → verify object size > 0 and list → delete files past retention → on any failure, send alert.
- Secrets (GitHub): `DB_URL`, `BACKUP_AGE_PUBLIC_KEY`, destination credentials. Never in the repo, never in logs.
- NOT covered by pg_dump: Storage file contents (32 buckets: IDs, selfies, receipts, HR docs). Needs a separate copy job
  (or confirm with Supabase). Say so on the form until done.
- Restore drill: restore one dump into a throwaway Supabase project once, check row counts against live, record the date.

### Draft workflow skeleton (text only)
```yaml
name: Offsite DB backup
on:
  schedule: [{cron: "0 22 * * *"}]
  workflow_dispatch:
jobs:
  dump:
    runs-on: ubuntu-latest
    steps:
      - run: sudo apt-get update && sudo apt-get install -y postgresql-client age
      - run: |
          pg_dump "$DB_URL" --format=custom --no-owner --schema=public --schema=auth --schema=storage -f db.dump
          age -r "$BACKUP_AGE_PUBLIC_KEY" -o db.dump.age db.dump && rm db.dump
          test -s db.dump.age
        env: {DB_URL: "${{ secrets.DB_URL }}", BACKUP_AGE_PUBLIC_KEY: "${{ secrets.BACKUP_AGE_PUBLIC_KEY }}"}
      # TODO after decision 1: upload step, retention step, failure alert
```

## What the report can say meanwhile
"The weekly export is partial. Full recovery relies on the platform's managed backups [settings: see Step 1, to be confirmed
by DATE]. An encrypted off-platform full backup is planned; destination, key holder and retention are pending decision."
