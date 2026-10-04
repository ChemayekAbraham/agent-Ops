# 6. Live State Verification

**Do not trust this documentation. Verify it.** Every fact in this folder came from the queries
below, run against production on 2026-09-09. Re-run them and compare. Where the answer differs,
the database is right and the document is stale — fix the document in the same change.

---

## The one-shot system census

```sql
SELECT
 (SELECT count(*) FROM pg_tables   WHERE schemaname='public') AS tables,
 (SELECT count(*) FROM pg_views    WHERE schemaname='public') AS views,
 (SELECT count(*) FROM pg_matviews WHERE schemaname='public') AS matviews,
 (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public') AS functions,
 (SELECT count(*) FROM pg_trigger  WHERE NOT tgisinternal) AS triggers,
 (SELECT count(*) FROM pg_policies WHERE schemaname='public') AS rls_policies,
 (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
   WHERE n.nspname='public' AND t.typtype='e') AS enums,
 (SELECT count(*) FROM cron.job) AS cron_jobs,
 (SELECT count(*) FROM cron.job WHERE active) AS cron_active,
 (SELECT count(*) FROM storage.buckets) AS buckets,
 (SELECT count(*) FROM public.general_ledger) AS ledger_rows,
 (SELECT count(*) FROM auth.users) AS auth_users;
```

### Baseline — 2026-09-09

| Metric | Value |
|---|---|
| Public tables | 641 |
| Views / materialized views | 71 / 6 |
| Functions (RPCs) | 1,907 |
| Non-internal triggers | 601 |
| RLS policies | 1,552 |
| Enum types | 33 |
| `pg_cron` jobs | 151 (142 active, 9 inactive) |
| Storage buckets | 27 (5 public) |
| `general_ledger` rows | 460,457 |
| Transaction groups | 215,482 |
| `auth.users` | 62,098 |
| Edge function directories in repo | 342 |
| Migration files in repo | 3,203 |
| `src/` TypeScript files | 2,503 |
| Ledger categories allowlisted | 120 |
| Triggers on `general_ledger` | 38 |
| Extensions | `pg_cron`, `pg_net`, `pg_stat_statements`, `pg_trgm`, `pgcrypto`, `pgmq`, `plpgsql`, `postgis`, `supabase_vault`, `uuid-ossp` |

Counts grow. A count that has **shrunk** is the interesting signal — something was dropped.

---

## Security checks — run these after any schema change

```sql
-- MUST return zero rows. Every public table needs RLS; the Data API is internet-facing.
SELECT t.tablename FROM pg_tables t
WHERE t.schemaname='public'
  AND NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=t.tablename AND c.relrowsecurity)
ORDER BY 1;
```

Baseline 2026-09-09: **0 rows.** Every one of the 641 tables has RLS enabled.

```sql
-- Which buckets are public? Expect exactly five.
SELECT id, public FROM storage.buckets WHERE public ORDER BY id;
-- email-assets, house-images, house-videos, products, service-centre-photos
```

```sql
-- The ledger fortress must be intact: 38 triggers, all enabled ('O').
SELECT tgname, tgenabled FROM pg_trigger t
JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname='general_ledger' AND NOT t.tgisinternal
ORDER BY tgname;
```

---

## Financial health

```sql
-- Ledger balance. unbalanced_multileg MUST be 0.
WITH g AS (
  SELECT transaction_group_id, count(*) AS legs,
         SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END) AS net
  FROM public.general_ledger
  WHERE classification='production' AND created_at >= now() - interval '30 days'
  GROUP BY transaction_group_id
)
SELECT count(*) AS groups_30d,
       count(*) FILTER (WHERE abs(net)>0.005 AND legs>1) AS unbalanced_multileg,
       count(*) FILTER (WHERE abs(net)>0.005 AND legs=1) AS single_leg
FROM g;
-- Baseline 2026-09-09: 32734 / 0 / 953

-- Kill switches
SELECT control_key, enabled, value, updated_at FROM public.treasury_controls ORDER BY 1;

-- Allowlisted ledger categories (120)
SELECT unnest(public.ledger_category_allowlist()) AS category ORDER BY 1;

-- Treasury cash. get_treasury_cash_position (A1+A5) is the canonical figure.
-- get_treasury_snapshot is SUPERSEDED and returns malformed negatives.
SELECT * FROM public.get_treasury_cash_position(now());

-- Drift and integrity detectors
SELECT * FROM public.ledger_group_imbalance_alerts ORDER BY created_at DESC LIMIT 50;
SELECT * FROM public.phantom_wallet_drift          ORDER BY created_at DESC LIMIT 50;
SELECT * FROM public.wallet_routing_violations     ORDER BY created_at DESC LIMIT 50;
SELECT * FROM public.wallet_unrouted_movements     ORDER BY created_at DESC LIMIT 50;
SELECT * FROM public.wallet_overdraw_events        ORDER BY created_at DESC LIMIT 50;
```

---

## Reading a function as actually deployed

Migrations lie. This does not.

```sql
SELECT pg_get_functiondef(p.oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname = 'create_ledger_transaction';

-- Overloads exist. List them before assuming there is one.
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef AS security_definer
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname = '<name>';
```

`create_ledger_transaction`, `apply_wallet_movement`, `reconcile_wallet_from_ledger` **all have
two overloads.** Check which one your caller resolves to.

---

## Scheduled jobs — the full live inventory

151 jobs, 142 active, recorded 2026-09-09. Times are UTC; EAT = UTC+3.

```sql
SELECT jobid, jobname, schedule, active,
       COALESCE(substring(command from 'functions/v1/([a-zA-Z0-9_-]+)'),
                substring(command from '(?i)(?:select|call)\s+([a-z0-9_]+)\s*\(')) AS target
FROM cron.job ORDER BY active DESC, schedule, jobname;
```

### Sub-minute and minute

| Schedule | Job |
|---|---|
| `30 seconds` | `deposit-bridge-worker-30s`, `process-agent-capability-jobs` |
| `* * * * *` | `expire-cash-deposit-codes`, `redispatch-withdrawals-1min` |

### Every few minutes

| Schedule | Jobs |
|---|---|
| `*/2` | `gmail-poll-transactions-every-2min`, `email-auto-match-retry-24h`, `email-auto-create-deposits-24h` |
| `*/3` | `refresh-wallet-totals-cache` |
| `*/5` | `deposit-bridge-gap-detector-5m`, `bridge-gap-alert-notify`, `detect-deposit-guardrail-alerts`, `gmail-withdrawal-backfill-every-5min`, `notify-cash-deposit-expired-sweep`, `refresh-mv-ops-daily-summary`, `welile-homes-sms-dispatch` |
| `*/10` | `reconcile-evidenced-withdrawal-settlements`, `reconcile-merchant-payout-funding`, `refresh-house-location-rollup`, `rent-amount-change-notify`, `sms-yoola-delivery-sweep-every-10min`, `sweep-withdrawal-settlement-states`, `tenant-self-repayment-notices-10min`, `promissory-pledge-notice-sweep` |
| `*/15` | `auto-reject-unmatched-deposits`, `deposit-match-alert-notify`, `detect-credit-limit-drift-15min`, `detect-sms-verification-failures`, `detect-unpaid-float-promises`, `hr-careers-acknowledge-15min`, `monitor-bulk-payout-stuck`, `purge_geo_coverage_cache`, `reconcile-merchant-payout-commissions`, `redirect-health-monitor-15min`, `refresh-agent-team-daily-collection-stats`, `refresh-tenant-idle-states`, `repair-wallet-cache-drift-15m`, `tenant-rent-intake-notices-15min`, `wallet-projection-drift` |
| `*/30` | `business-advance-stage-reminders`, `detect-merchant-float-variances`, `gsc-auto-verify-every-30-min` |

### Hourly and multi-hour

`detect-tenant-phone-near-duplicates-hourly` (`0 * * * *`), `partner-self-claims-expire-hourly`,
`reconcile-advance-statuses`, `expire-stale-bonus-restrictions`, `reconcile-agent-landlord-float`,
`release-stale-merchant-float`, `notify-house-booking-drain`,
`recalculate-trust-scores-rolling` (every 2 h), `change-of-address-monitor-3h`,
`sitemap-resubmit-every-6h`, `seo-index-monitor-6h`, `detect-stale-withdrawal-holds`,
**`process-agent-advance-deductions-6h`** (every 6 h — *not* daily 18:00 EAT as
`SYSTEM_CONTEXT.md` states), `retry-no-smartphone-charges-3h` (every 8 h),
`recover-merchandise-from-wallets` (`0 5,11,17,23`).

### Daily — money-moving jobs are marked

| UTC | Job | Moves money |
|---|---|---|
| 00:00 | `apply-payroll-growth-daily`, `process-scheduled-payouts-daily` | **yes** |
| 00:10 | `agent-ops-snapshot-cycle`, `resume-expired-repayment-pauses` | |
| 00:30 | `snapshot-agent-daily-eligibility` | |
| 01:00 | `recognize-fee-revenue-daily` | **yes** |
| 01:10 | `partner-self-returns-accrual-daily` | **yes** |
| 01:15 | `reconcile-credited-deposit-profiles` | |
| 01:25 | `partner-self-payouts-daily` | **yes** |
| 02:00 | `weekly-database-backup` (Sundays) | |
| 02:15 | `nightly-wallet-ledger-reconciliation`, `prune-cron-job-run-details`, `purge-rejected-listings-daily` | |
| 02:20–02:50 | `prune-net-http-response`, `prune-sms-delivery-log`, `prune-withdrawal-notification-log`, `prune-client-error-reports`, `prune-deposit-decision-audit`, `detect-payout-proof-integrity`, `hr-metric-snapshots-daily`, `cc-metric-snapshots-daily` | |
| 03:00 | `deposit-monitoring-report-0600`, `generate-wallet-report-morning-06eat` | |
| 03:10 | `merchant-payout-success-daily`, `psm-release-expired-promissory-bookings` | |
| 03:15 | `psm-release-expired-house-bookings` | |
| 03:17 | `purge_login_phase_events` | |
| 03:20 | `cleanup-mcp-public-rate-limits`, `smartphone-overdue-surcharges-daily` | **yes** |
| 03:30 | `agent-ops-receivables-report-daily`, `relink-stuck-pending-deposits-daily` | |
| 04:00 | `agent-growth-daily-report-0700-eat`, `merchant-float-morning-report`, `process-scheduled-payouts-chef-rodger-0700eat` | **yes** |
| 05:05 | `payout-acceptance-checks`, `run-payout-acceptance-checks` | |
| **06:00** | `auto-charge-wallets-daily`, `auto-process-supporter-roi`, `daily-credit-charges`, `lending-auto-deduct-daily` | **yes — the heaviest money hour** |
| 06:00 | `notify-agent-collection-lapse-daily`, `notify-promissory-note-release-daily`, `proxy-target-nudge-morning`, `sms-failure-daily-alert` | |
| 06:05/06:10 | `psm-queue-promissory-release-warnings`, `psm-queue-house-release-warnings` | |
| 06:30 | `apply-rent-overdue-penalty-daily` | **yes** |
| 07:00 | `expire-subagent-invites-daily`, `pay-landlord-rent-daily` | **yes** |
| 07:15 | `welile-homes-landlord-payouts` | **yes** |
| 09:00 | `deposit-monitoring-report-1200`, `generate-wallet-report-midday-12eat`, `proxy-target-nudge-midday` | |
| 12:00 | `proxy-target-nudge-afternoon` | |
| 14:00 | `engrep-catalog-snapshot-1700-eat` | |
| 15:00 | `auto-apply-pending-topups-6pm`, `deposit-monitoring-report-1800` | **yes** |
| 15:30 | `agent-ops-daily-report-1800-eat` | |
| 16:00 | `merge-paidout-topups-7pm` | **yes** |
| 16:30 | `send-agent-capacity-card-daily` | |
| **16:50** | **`sweep-agent-advance-recovery`** — daily, *not* every 15 min as documented | **yes** |
| 17:00 | `agent-daily-performance-report-2000-eat` | |
| 18:00 | `partner-ops-daily-report-2100-eat` | |
| 19:00 | `merchant-cashout-daily-report-2200-eat` | |
| 20:55 | `daily-merchant-commission-report` | |
| 20:59 | `daily-cmo-users-report` | |
| 21:00 | `agent-ops-comprehensive-daily-report`, `apply-scheduled-portfolio-renewals`, `daily-cto-report`, `daily-wallet-inflows-report`, `generate-daily-wallet-report`, `merchant-cashout-daily-report`, `tenant-products-services-report` | renewals **yes** |
| 21:05 | `pin-agent-expected-day-eat-midnight` | |
| 22:20 / 22:40 | `snapshot-receivables-forecast`, `grade-receivables-forecast` | |
| 23:00 | `auto-close-fully-repaid-rents`, `business-advance-daily-compounding`, `trigger-agent-liability-daily` | compounding **yes** |
| 00:05 | `daily-landlord-ops-report` | |

### Weekly

`weekly-database-backup` (Sun 02:00), `semrush-brand-tracker-weekly` (Mon 06:00),
`weekly-cto-report-board` (Tue 21:00), `weekly-agent-ops-report` / `weekly-landlord-ops-report` /
`weekly-tenant-ops-report` (Wed 10:00), `landlord-daily-guarantee-sms` (Mon+Fri 15:00).

### Inactive — nine jobs, left off deliberately

`refresh-daily-stats`, `cleanup-old-system-events`, `refresh-financial-summaries-daily`,
`check-agent-liquidity-hourly`, `process-debt-recovery-daily`,
`process-promissory-deductions-daily`, `partner-ops-automation-daily`, `vacancy-alerts-daily`,
`daily-recalculate-credit-limits`.

**Do not enable one without understanding why it was stopped.** Several move money.

### Watching a job

```sql
SELECT j.jobname, d.status, d.start_time, d.end_time, left(d.return_message,300) AS msg
FROM cron.job_run_details d JOIN cron.job j USING (jobid)
WHERE j.jobname = '<name>' ORDER BY d.start_time DESC LIMIT 20;
```

`prune-cron-job-run-details` runs daily at 02:15 — **run history is short.** Capture evidence
before it is pruned.
