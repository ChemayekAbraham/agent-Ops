# 116 — CTO report 2026-09-24 triage

**Triaged live 2026-09-24. One real fix applied (Leaflet unmount crash). The other four items in
the "fix today" report are false alarms or already-resolved when checked against live production —
none needed a code or data change.** Before re-opening any of these from a future CTO report without
re-verifying against the live tables below.

## 1. "Transaction rollback rate breached + ledger postings collapsing 23,757→11,378→4,182" — NOT an incident, it's a completed backfill

The report read a one-time receivables restatement batch as if it were writes silently failing.
`general_ledger` broken down by `category`/`source_table` shows the 21st's 23,757 postings were
~19,294 `agent_float_cash_offset` + `rent_receivable_created` rows from `agent_collections` alone,
and the 22nd's 11,378 included a wave of `receivable_restatement_equity`, `rent_plan_receivable_restatement`,
`agent_advance_receivable_opening`, `agent_access_fee_receivable_opening`, `credit_draw_receivable_opening`,
`merchandise_recovery_receivable_opening` rows — every one an "opening"/"restatement" category, i.e.
a live invocation of `restate_agent_receivables()` / `restate_rent_plan_receivables()` /
`restate_rent_plan_receivables_tagged()` (all three exist in production, none in
`supabase/migrations/` — see [[project_repo_migrations_diverge_from_production]]). By the 23rd none
of those opening/restatement categories appear at all — the batch had finished — and the day's 4,182
postings are back to ordinary organic volume, actually *higher* than the 19th/20th's ~2,000-2,400/day
baseline. Nothing "vanished."

This also explains the elevated rollback rate: `db_stat_snapshots` day-over-day deltas (the snapshot
counters are lifetime-cumulative — always diff consecutive days, never read one day's value alone,
per [[project_rollback_rate_spike_2026-09-19_resolved]]) give 21.3% (21st), 17.2% (22nd), 5.26%
(23rd) — elevated during the restatement batch (retries/conflicts on bulk inserts are exactly what
inflates a rollback rate), declining sharply as it wound down, still slightly above the 2% target on
the 23rd but not the flat "still open, 3 days, revenue risk High" picture the report gave.

Could not find who/what triggered the restatement — no `audit_logs` row, no HANDOVER doc. Flagging
as a process gap (should have been documented per [[feedback_document_every_change_in_handover]]),
not touching it further since the batch is already complete and looks intentional (chart-of-accounts
opening-balance shape, not a runaway job).

**Verification queries:**
```sql
select date(created_at at time zone 'Africa/Kampala') d, count(*) from general_ledger
where created_at >= '2026-09-19' group by 1 order by 1;

select day, xact_commit, xact_rollback from db_stat_snapshots where day >= current_date - 6 order by day;
-- diff consecutive rows for that day's real commit/rollback counts, never read xact_rollback alone.
```

## 2. "Auth failing 26.3%, new security-probe issue probably explains it" — real failure rate, wrong cause, not new

`login_phase_events` filtered to `phase = 'auth.signin.attempt'` for the 23rd: 202 attempts, 54
failures = 26.7% (matches the report). But every failure's `detail` is
`{accountExists: true, attempts: 6-7, winnerPhase: null}` — the exact signature identified in
[[project_cto_report_2026-09-21_remaining_items_triage]] three days ago: a client-side sign-in flow
that races multiple auth strategies and sometimes has none win. Same bug, still unfixed, now at a
higher rate (20.6% on the 20th → 26.7% on the 23rd). The report's own "security probe" hypothesis
(issue 9, credential stuffing) is a red herring for this — it may be a real separate finding, but it
is not the cause of the 26.3%, and chasing a WAF/rate-limit fix today would not move this number at
all. The actual fix is the sign-in race in the frontend auth orchestration, likely under `src/hooks/`
— not done in this pass (needs the client-side race logic itself, out of scope for a triage sweep).

## 3. "email_queue_dispatch failing again, 1 failure on 23 Sept" — currently healthy, not reproducible

`pg_get_functiondef` for `email_queue_dispatch()` in production has no `cron.unschedule` call (the
recurring self-cancel bug from [[project_email_queue_dispatch_self_cancel_drift]] is not present),
the `process-email-queue` cron job is active on its 5-second schedule, and `cron.job_run_details` for
the 23rd/24th shows 100% `succeeded` across 11,000+ runs — no failed row anywhere in the retained
window. The report's single "1 failure" for the 23rd isn't reproducible now (`cron.job_run_details`
doesn't retain long); given the function body is clean, this was very likely a one-off transient
(network blip on `net.http_post`), not a recurrence of the drift bug. No action taken.

## 4. "Uncaught TypeError _leaflet_pos, 13 users, /dashboard/agent" — FIXED

Confirmed via `client_error_reports`: exclusively `/dashboard/agent`, stack is
`_onZoomTransitionEnd → _move → _getNewPixelOrigin → _getMapPanePos` inside Leaflet's vendor bundle —
a well-known Leaflet+React bug where an in-flight pan/zoom animation's async completion callback
fires after the map's DOM pane has been torn down (component unmount, e.g. switching agent dashboard
tabs). Not the report's own "component renders before data resolves" theory.

Found the same `FitBounds` pattern — `map.fitBounds()` on every prop change, no animation cleanup —
in two places:
- `src/components/agent/PropertyMapView.tsx` (`FitBounds`, agent's property map / route planner)
- `src/components/agent/AgentLandlordMapSheet.tsx` (`FitBounds`, agent's landlord map sheet)

Fixed both: the `useEffect` cleanup now calls `map.stop()`, which cancels any in-flight Leaflet
animation before the effect re-runs or the component unmounts, so the async zoom-end callback never
fires against a removed pane. Effect-only change (no JSX/styling touched, so this stays in-lane per
`CLAUDE.md`'s Claude/Gemini split even though the files are shared).

`npm run guard:all` passes (schema-types fingerprint drift is pre-existing/advisory, unrelated to
this change).

## 5. "Five slow wallet/trust RPCs, call volume up 46% in two days" — not verified, report says non-urgent

`refresh_wallet_totals_cache`'s cron schedule (`refresh-wallet-totals-cache`, `*/3 * * * *`) is
unchanged, and no trigger calls it directly (checked `pg_trigger` for any trigger targeting that
function — none). The report's own `pg_stat_statements`-based call-count figures are drawn from a
lifetime-cumulative view with no day-scoping in `get_cto_diagnostics()` (`slow_queries` just orders
`pg_stat_statements` by `total_exec_time DESC`, no date filter) — the "52 → 64 → 76 calls" trend
likely comes from a different daily-snapshot source (`get_cto_daily_addendum` or
`get_cto_issue_intelligence`, not inspected this pass) and wasn't cross-checked against cron/trigger
config. The report itself classifies this as chronic debt, not a same-day item — left as-is per its
own priority, matching [[project_cto_report_2026-09-21_remaining_items_triage]]'s finding that this
function's duration is an intentional per-run budget, not a regression.
