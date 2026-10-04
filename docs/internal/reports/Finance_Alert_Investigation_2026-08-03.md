# WELILE FINANCE ALERT [CRITICAL] — Read-Only Architectural Investigation

Date: 2026-08-03 · Scope: read-only. No data, cron, trigger, threshold or alert change was made.

## 1. Alert Architecture

| Layer | Component | Evidence |
|---|---|---|
| Trigger | pg_cron job every 15 min (:00/:15/:30/:45) invoking the edge function with trigger_source='cron'; also 'publish' and 'manual' | finance_anomaly_scans rows land at exact quarter-hour boundaries, all trigger_source='cron'; header comment index.ts:8-11 |
| Detection | public.detect_finance_anomalies(p_min_amount) — 9 hard-coded checks | pg_proc.prosrc |
| Result persistence | public.run_finance_anomaly_scan(p_trigger_source) inserts one row per run into finance_anomaly_scans | pg_proc.prosrc |
| Severity/aggregation | inside detect_finance_anomalies (v_severity ladder) | see section 3 |
| Notification | supabase/functions/finance-anomaly-scan/index.ts | lines 198-293 |
| Recipients | finance_anomaly_alert_config id=1 allow-list only, no role fallback | index.ts:185-231 |
| Email | enqueue_email('transactional_emails') -> process-email-queue, from "Welile Reports <info@welile.com>" | index.ts:248-277 |
| SMS | sendSMS() multi-provider | index.ts:279-293 |

Live config: enabled=true, min_amount=1000, notify_emails={joshwanda17@gmail.com}, notify_phones={+256704825473} — matches the pinned constraint in mem/constraints/finance-anomaly-alert-recipients.md. Recipient selection is correct and is NOT a defect.

## 2. Execution Flow

```
pg_cron (15 min)
  -> edge fn finance-anomaly-scan
    -> config gate (enabled?)                    index.ts:185-196
    -> rpc run_finance_anomaly_scan('cron')      index.ts:198
        -> detect_finance_anomalies(NULL)  (9 checks)
        -> INSERT finance_anomaly_scans    (audit row, new scan_id each run)
    -> if anomaly_count == 0 and !force -> EXIT  index.ts:212-223   <-- ONLY suppression path
    -> build HTML report + SMS summary           index.ts:113-164
    -> queue email to allow-list                 index.ts:248-277
    -> send SMS to allow-list                    index.ts:279-293
    -> stamp scan row notified=true              index.ts:298-311
    -> emit system_event finance_anomaly_scan_completed
```

SMS template (index.ts:161-163):
`WELILE FINANCE ALERT [{SEVERITY}]: {n} wallet/ledger anomalies, exposure UGX {x}. {top 3 checks}. Full report emailed.`

## 3. Severity Classification Rules

Severity is NOT money-weighted, NOT persistence-weighted, NOT percentage-weighted. It is a max-of-category ladder triggered by a SINGLE non-zero row in any category.

| # | Check key | Condition | Window | Severity when count>0 |
|---|---|---|---|---|
| 1 | wallet_cache_vs_ledger | wallets vs v_user_wallet_strict, any bucket delta >= min_amount | all time | critical |
| 2 | negative_wallet_buckets | any bucket < 0 | all time | critical |
| 3 | pivot_drift | wallet_pivot_drift_view delta >= min_amount | all time | high |
| 4 | unbalanced_ledger_groups | cash_in <> cash_out per transaction_group_id | 24 h | critical |
| 5 | orphan_wallet_legs | ledger_scope='wallet' AND user_id IS NULL | all time (no window) | critical |
| 6 | routing_violations | wallet_routing_violations | 24 h | high |
| 7 | unrouted_movements | wallet_unrouted_movements | 24 h | high |
| 8 | overdraw_events | wallet_overdraw_events | 24 h | medium |
| 9 | wallet_legs_missing_bucket | wallet legs with wallet_bucket IS NULL | 24 h | medium |

Escalation: critical > high > medium. anomaly_count is the SUM of rows across all checks; total_exposure the SUM of absolute amounts across all checks. A large comparator artifact therefore inflates the headline of an alert whose severity was set by a different, tiny category. That is exactly what is happening.

## 4. Current Alert Inventory (latest scan 2026-08-03 04:15 UTC)

Headline: critical, 475 anomalies, exposure UGX 44,692,158.

| Check | Count | Amount (UGX) | Severity |
|---|---|---|---|
| wallet_cache_vs_ledger | 2 | 51,228 | critical |
| negative_wallet_buckets | 0 | — | clean |
| pivot_drift | 435 | 44,065,730 | high |
| unbalanced_ledger_groups | 0 | — | clean |
| orphan_wallet_legs | 8 | 575,200 | critical |
| routing_violations | 0 | — | clean |
| unrouted_movements | 0 | — | clean |
| overdraw_events | 0 | — | clean |
| wallet_legs_missing_bucket | 30 | 161,654 | medium |

98.6% of reported exposure comes from one category (pivot_drift) that is a comparator defect.

## 5. Read-Only Recomputation and False-Positive Analysis

| Alert | Reported | Recomputed now | Actual risk | Financial impact | Classification | SMS-worthy? |
|---|---|---|---|---|---|---|
| pivot_drift | 435 / 44,065,730 | 435 / 44,065,730 | None | UGX 0 | Comparator defect (false positive) | No |
| wallet_cache_vs_ledger | 2 / 51,228 | 3 / ~57,468 | Low, real | <= UGX 57,468 | True positive, immaterial | Email/dashboard |
| orphan_wallet_legs | 8 / 575,200 | 8, all dated 2026-07-22..26 | Data-quality only | UGX 0 movement | Frozen historical artifact | No |
| wallet_legs_missing_bucket | 30 / 161,654 | 30 (27 system_balance_correction, 3 agent_commission_earned) | Labelling only | UGX 0 | Mostly expected behaviour | No |
| negative buckets / unbalanced groups / routing / unrouted / overdraw | 0 | 0 | — | — | Clean | n/a |

### Proof that pivot_drift is a comparator defect

wallet_pivot_drift_view computes the cache side as:

```sql
COALESCE((v.j ->> 'withdrawable_raw')::numeric, 0)   -- also 'float_raw', 'advance_raw'
FROM wallets_physical wp
LEFT JOIN LATERAL get_user_wallet_view(wp.user_id) v(j) ON true
```

get_user_wallet_view() actually returns:

```json
{"user_id":"...","withdrawable":7000000,"float_balance":7000000,
 "advance_balance":0,"pending_holds":0,"total_visible":14000000,"restricted_held":0}
```

There is NO withdrawable_raw / float_raw / advance_raw key. Every ->> returns NULL, COALESCE(...,0) makes the "cache" side hard-zero for every user, so drift = 0 - pivot_balance, i.e. the view reports each funded user's entire balance as drift.

Confirmation over the 435 flagged users:

| Comparison | Mismatching users |
|---|---|
| pivot vs v_user_wallet_strict (ledger truth) | 1 of 435 |
| the view's "cache" column vs v_user_wallet_strict | 416 of 435 |

Example user 2ef293fd-...: wallets.withdrawable_balance = 7,000,000; v_user_wallet_strict.withdrawable = 7,000,000; ledger_balance_pivot = 7,000,000; the view reports cache_withdrawable = 0 and withdrawable_drift = -7,000,000.

The pivot table itself is healthy: 55,930 of 55,998 wallets have pivot rows, 0 flagged users have an empty pivot, and the pivot agrees with the strict ledger. The earlier "pivot never populated" hypothesis is disproven — the defect now sits in the view's cache-side key names.

## 6. Root Cause Analysis

1. Primary (98.6% of exposure): key-name mismatch in wallet_pivot_drift_view (*_raw vs actual keys). Every funded wallet is permanently "drifting". Monitoring defect, zero financial impact.
2. Secondary (why severity says CRITICAL): orphan_wallet_legs — 8 legs dated 22-26 July (agent_float_deposit, system_balance_correction) — is the only all-time-window CRITICAL check with a non-zero count and can never self-clear because ledger rows are immutable. Together with the 2-3 genuine small cache drifts it pins severity at critical permanently.
3. Why the identical SMS every 15 minutes: the notifier has no dedup, no state comparison, no acknowledgement check and no cool-down. index.ts:212-223 is the only suppression path and fires only when anomaly_count === 0. Every run mints a new scan_id, so the SMS idempotency key (finance-anomaly:{scan_id}:{phone}, index.ts:287) is unique per run and cannot dedup. Result: 48 scans in 17 h, all critical, all anomaly_count=475, all total_exposure=44,692,158, all notified=true. The scan is NOT reading stale data — it recomputes fully each run; the inputs genuinely never change.
4. Contributing: anomaly_count and total_exposure mix categories, so a comparator artifact dominates the headline figure executives see.

## 7. Financial Risk Assessment

| Area | Affected? | Notes |
|---|---|---|
| User balances | No | wallets agrees with v_user_wallet_strict for 55,995 of 55,998 wallets |
| Withdrawals | No | gate uses get_user_available_balance (strict); untouched by the pivot view |
| Deposits | No | no unbalanced groups, routing violations or unrouted movements in 24 h |
| Ledger integrity | No | 0 unbalanced groups in 24 h; the 8 orphan legs are owner-label gaps, not value gaps |
| Financial reporting | Marginal | the 8 orphan wallet legs (UGX 575,200) are unattributed per user |
| Executive dashboards | Yes, adversely | headline exposure overstated by ~44.07 M (44.7 M reported vs ~0.06 M real) |
| Monitoring only | Yes | this is where the real defect lives |

Genuine financial exposure today: approximately UGX 57,468 across 3 wallets (Sharif Kc +1,228; JOSHUA WANDA -50,000; Muyomba Peter +6,240) = 0.13% of the reported figure. Executives are being paged about monitoring inconsistencies, not financial incidents.

## 8. Monitoring Risk Assessment

- Alert fatigue: 96 identical CRITICAL SMS per day to a single owner; a real incident would be indistinguishable from the noise.
- The comparator fails silently: a view referencing non-existent JSON keys degrades to 0 instead of erroring.
- No materiality floor: a 1,228 UGX cache delta yields the same CRITICAL as a 10 M breach.
- Checks 1 and 5 have no time window, so historical rows escalate forever.
- finance_anomaly_scans has no retention or rollup; it grows unbounded (48 rows in 17 h).

## 9. Recommended Alert Hierarchy (recommendation only — nothing implemented)

| Category | Recommended channel | Rationale |
|---|---|---|
| unbalanced_ledger_groups (24 h) | SMS immediately | true double-entry breach |
| negative_wallet_buckets | SMS immediately | real user-visible money defect |
| wallet_cache_vs_ledger | SMS only above a materiality floor (e.g. >= 100 K single user or >= 1 M aggregate); email below | today's 57 K is not a paging event |
| routing_violations, unrouted_movements (24 h) | Email | triage, not paging |
| overdraw_events (24 h) | Email | the clamp is protective behaviour |
| orphan_wallet_legs | Dashboard only; add a time window or an acknowledged-exclusion list | immutable historical rows can never self-clear |
| wallet_legs_missing_bucket | Dashboard only; exclude system_balance_correction | labelling, no value impact |
| pivot_drift | Never escalate until the view is fixed | 100% monitoring artifact today |

Cross-cutting recommendations:
1. Fix wallet_pivot_drift_view key names (withdrawable / float_balance / advance_balance) before trusting any pivot number.
2. Require persistence (same finding in >= 2 consecutive scans) before escalating anything below critical.
3. Add state-change dedup: notify only when the fingerprint of (per-check counts + severity) changes, plus an optional low-frequency heartbeat.
4. Add auto-close semantics and an acknowledgement store so an acknowledged historical artifact stops paging.
5. Report total_exposure per category, never as one mixed sum.
6. Add retention/rollup to finance_anomaly_scans.

## 10. Evidence Index

- supabase/functions/finance-anomaly-scan/index.ts — 150-164 (SMS template), 185-231 (config + recipients), 198-223 (scan + only suppression path), 279-293 (SMS send, per-scan idempotency key), 298-311 (notified stamp).
- public.detect_finance_anomalies / public.run_finance_anomaly_scan — pg_proc.prosrc: all 9 checks, windows, severity ladder.
- pg_get_viewdef('public.wallet_pivot_drift_view') — the *_raw key references.
- get_user_wallet_view('2ef293fd-...') — actual returned keys, no *_raw.
- finance_anomaly_scans — 48 rows 2026-08-02 11:15 -> 2026-08-03 04:15, all critical / 475 / 44,692,158 / notified=true.
- Live recomputations: 435 pivot-drift rows (0 with empty pivot; 1/435 pivot-vs-strict mismatch; 416/435 view-cache-vs-strict mismatch); 3 real cache-vs-strict wallets; 8 orphan wallet legs 2026-07-22..26; 30 missing-bucket legs (27 system_balance_correction, 3 agent_commission_earned).
- finance_anomaly_alert_config — enabled=t, min_amount=1000, one email + one phone (matches pinned constraint).

## 11. Addendum — cron provenance reconciliation

A parallel static code trace found **no `cron.schedule` entry in `supabase/migrations/*.sql`** that invokes `run_finance_anomaly_scan` or the `finance-anomaly-scan` edge function (37 `cron.schedule` occurrences scanned; zero reference it). The `"cron"` trigger source in `index.ts:9-10` is therefore **not registered through a tracked migration**.

Live data closes the gap: all 48 rows in `finance_anomaly_scans` (2026-08-02 11:15 → 2026-08-03 04:15) carry `trigger_source='cron'` and land on exact quarter-hour boundaries. A pg_cron job therefore **does** exist in the database but was created out-of-band (dashboard/ad-hoc SQL), not via migration. `cron.job` is not readable from the app role (`permission denied for schema cron`), so its exact schedule string cannot be quoted — the 15-minute cadence is inferred from the timestamp series, which also shows occasional missed slots (48 runs where 68 were due).

This is an **infrastructure-governance defect** in its own right: a job that pages an executive every 15 minutes is not represented in version control, so it cannot be reviewed, reasoned about, or rolled back through code.

Also confirmed by the static trace: the detector reads `wallet_pivot_drift_view` (not `ledger_balance_pivot` directly), the SMS goes out through `_shared/sendSmsMultiProvider.ts` (Yoola → Africa's Talking → Lana chain), and RLS on `finance_anomaly_alert_config` limits reads to cfo/cto/ceo/super_admin and updates to cfo/super_admin.
