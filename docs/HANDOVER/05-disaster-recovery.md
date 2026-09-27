# 5. Disaster Recovery

For the case the founder is most worried about: infrastructure is gone, or access to it is, and
someone has to bring Welile back.

---

> **2026-09-27 correction (doc 141):** the weekly backup only ever captured the first 1000 rows of each table (PostgREST row cap). Its `row_count` is misleading. The ledger now has its own verified backup; see `141-general-ledger-backup-emailed-to-josh.md`.

## Read this first — the backup you have is not the backup you need

`weekly-database-backup` runs Sundays at 02:00 UTC and is genuinely working. Last successful run
verified 2026-09-06: status `success`, 1,716,881 rows, 10.7 MB.

**But:**

| What it is | What that means |
|---|---|
| A **CSV export of 91 tables** | The database has **641 tables**. Roughly 86% of the schema is not in it |
| **Data only** | No schema, no functions (1,907), no triggers (601), no RLS policies (1,552), no enums, no cron jobs |
| **Weekly** | Up to 7 days of financial history can be lost |
| Delivered to `joshwanda17@gmail.com`, `weliletechnologies@gmail.com`, `pexpert46@gmail.com` | Two of the three are **personal** accounts. If the founder leaves, backup delivery follows them out |
| Stored in the `db-backups` storage bucket | Same project as the thing it is backing up. A project-level loss takes the backups with it |

**This export cannot rebuild the platform.** It is a data extract for analysis, not a disaster
recovery artefact.

### Actions required — do these before relying on any of this

1. **Confirm the Supabase/Lovable Cloud managed backup and PITR settings.** This is the real
   recovery mechanism and it is not visible from SQL. Check the Cloud dashboard, write the
   retention window here, and test a restore.
2. **Get the backups off-platform.** Copy to storage in a different account and provider.
3. **Change the recipients to company addresses**, not personal Gmail.
4. **Add schema to the backup**, not just rows — `pg_dump --schema-only` equivalent, committed or
   archived, so functions, triggers and policies survive.
5. **Do a restore drill.** A backup nobody has restored is a hypothesis.

```sql
-- Is the weekly backup still succeeding?
SELECT created_at, status, table_count, row_count, size_bytes, error_message
FROM public.backup_runs ORDER BY created_at DESC LIMIT 10;
```

---

## What can and cannot be rebuilt from git

| Asset | In git? | Recoverable? |
|---|---|---|
| Frontend (2,503 TS/TSX files) | Yes | Fully |
| 342 edge functions | Yes, `supabase/functions/` | Fully |
| 3,203 migration files | Yes | **Only approximately** — they do not faithfully reflect the live schema |
| Database schema as actually deployed | **No** | Only from a managed backup or a live dump |
| Live data (460k ledger rows, 62k users) | **No** | Only from a managed backup |
| 151 cron jobs | **No** — created with the insert tool, not migrations | Must be recreated by hand |
| Edge function secrets | **No**, by design | Must be re-obtained from each vendor |
| Storage bucket contents (27 buckets: receipts, IDs, agreements, proofs) | **No** | Only from a managed backup |
| RLS policies, triggers, functions | Partially, via migrations | **Verify every one against a live dump** |

The honest summary: **git gives you the application, not the platform.** The database is the
company.

---

## Rebuild order

If you are provisioning from nothing, this is the sequence. Order matters — later steps depend on
earlier ones.

### Phase 1 — Restore the database (nothing else matters until this is done)

1. Create the Supabase / Lovable Cloud project.
2. Restore from the managed backup. If you only have the CSV export, stop and escalate: you are
   rebuilding a schema by hand from 3,203 unreliable migrations, and you should get a real dump
   before writing a single line.
3. Verify the extensions are present: `pg_cron`, `pg_net`, `pg_stat_statements`, `pg_trgm`,
   `pgcrypto`, `pgmq`, `plpgsql`, `postgis`, `supabase_vault`, `uuid-ossp`.
4. Run every check in [`06-live-state-verification.md`](./06-live-state-verification.md) and
   compare against the recorded baselines. **Do not proceed while a count is short.**
5. Confirm **RLS is enabled on every public table**. The baseline is zero tables without it. A
   single table missing RLS is a live data breach, because the Data API is public.

### Phase 2 — Secrets

Re-obtain from each vendor and set as Edge Function secrets. Full inventory in
[`01-ownership-and-access.md`](./01-ownership-and-access.md#secrets-inventory).

Minimum set to be functional at all: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_ANON_KEY`, `YOOLA_SMS_API_KEY` (no logins without it), `MAILGUN_API_KEY` +
`MAILGUN_DOMAIN`, `GOOGLE_MAIL_API_KEY` (no deposit matching without it).

### Phase 3 — Edge functions

Deploy **one at a time**, never in bulk. See
[`02-danger-zones.md`](./02-danger-zones.md#3-never-deploy-all-edge-functions-at-once).

`supabase/config.toml` (project ref `wirntoujqoyjobfhyelc`) lists the functions that run with
`verify_jwt = false` — public webhooks, cron targets and onboarding endpoints. **Anything not
listed keeps the default `verify_jwt = true`.** Getting this wrong either breaks a webhook or
exposes an authenticated endpoint to the internet.

Priority order:

1. Auth and messaging — `sms-otp`, `otp-login`, `phone-signup`, `send-sms`, `send-email`
2. Money in — `approve-deposit`, `gmail-poll-transactions`, `cash-deposit-verify-code`
3. Money out — `approve-withdrawal`, `redispatch-withdrawals`
4. Core engines — `auto-charge-wallets`, `process-supporter-roi`, `approve-rent-request`
5. Reports and everything else

### Phase 4 — Cron jobs

**These are not in git.** All 151 must be recreated. Extract them from the old database before it
is gone:

```sql
SELECT jobname, schedule, command, active FROM cron.job ORDER BY jobname;
```

If the old database is already unreachable, [`06-live-state-verification.md`](./06-live-state-verification.md)
carries the full inventory of job names and schedules recorded on 2026-09-09 — you will have to
reconstruct each `command` body from the function it targets.

Bring them up **last and deliberately**. Several move money: `auto-charge-wallets`,
`process-supporter-roi`, `process-agent-advance-deductions`, `pay-landlord-rent`,
`process-scheduled-payouts`, `lending-auto-deduct`.

Leave the nine deliberately-inactive jobs inactive.

**Before enabling any money job, set the matching `treasury_controls` switch off**
(`auto_roi`, `auto_advances`, `auto_salaries` are currently `false`) and turn them on one at a
time while watching the ledger.

### Phase 5 — Frontend

```bash
npm install
npm run guard:all
npm run build
```

Requires `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`,
`VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY`. Served as a static SPA behind the Lovable
proxy, HTML `no-cache`. No service worker — do not add one.

### Phase 6 — DNS and domains

`welileapp.com` is canonical. Also `www.welileapp.com`, `api.welileapp.com`,
`notify.welile.com` (Mailgun). `scripts/guard-legacy-domain.mjs` fails the build on any reference
to a legacy domain; `scripts/site-domains.mjs` holds the list.

### Phase 7 — Storage buckets

27 buckets must exist with correct public/private flags. Only these five are public:
`email-assets`, `house-images`, `house-videos`, `service-centre-photos`, `products`.

**Every other bucket is private and must stay private** — they hold national IDs, LC1 letters,
payment proofs, landlord agreements, HR documents, resumes and wallet statements. Making one
public is a personal-data breach.

Full list: `agent-receipts`, `analytics-exports`, `avatars`, `budget-documents`,
`business-advance-documents`, `database_export_23_07_26`, `db-backups`, `email-assets`,
`finops-reports`, `house-images`, `house-videos`, `hr-documents`, `investment-receipts`,
`landlord-agreements`, `landlord-payout-receipts`, `lc-letters`, `merchandise`,
`offline-collection-proof`, `partner-agreements`, `payment-proofs`, `products`,
`requisition-attachments`, `resumes`, `reviews`, `service-centre-photos`, `task-evidence`,
`wallet-statements`.

---

## Bringing the platform back up safely

Do not open the doors all at once.

1. `maintenance_mode.enabled = true` throughout the rebuild.
2. Verify the ledger balances — the 30-day multi-leg check in
   [`03-money-invariants.md`](./03-money-invariants.md#is-the-ledger-healthy-right-now) must
   return zero.
3. Reconcile wallets: let `nightly-wallet-ledger-reconciliation` and
   `repair-wallet-cache-drift-15m` run a full cycle, then check the drift views are empty.
4. Enable read-only access. Confirm balances look right to real users before allowing writes.
5. Enable deposits before withdrawals. Money in is recoverable; money out is not.
6. Turn off `maintenance_mode`.
7. Watch `phantom_wallet_drift`, `ledger_group_imbalance_alerts` and `wallet_routing_violations`
   for 24 hours.

---

## Data export while the system is alive

- Per-table or per-query CSV via `psql COPY ... TO STDOUT`.
- Full database export via Cloud → Advanced settings → Export data.
- **There is no self-serve import.** Restoring is a support-assisted operation. Factor that into
  your recovery time estimate — and find out the real number *before* you need it.
