# Active Tasks

1. ~~Self-support house funding confirmation dialog + queue removal~~
   - ~~Add confirmation dialog before "Fund these houses" submits.~~
   - ~~Exclude houses already in `partner_supported_houses` (pending/active) from `agent_list_empty_house_opportunities` so funded houses leave the queue.~~

2. ~~Supported empty-house portfolio approval email~~
   - ~~Wire `self_managed_house` portfolios into the same `partner-self-managed-deployment` template used for rent plans (house lines instead of tenant lines), skipping landlord/agent float SMS.~~
   - ~~Resend for portfolio WSH-9681 (UGX 140,000, SSENKAALI PIUS).~~

## Email transport incident (2026-08-30)

- ~~Diagnose global Mailgun 401 — root cause: Mailgun API key disabled account-side.~~
- ~~Stop 401s from DLQ-ing mail: `process-email-queue` now treats 401 as a transport outage (message stays queued, 15-min cooldown).~~
- Replace `MAILGUN_API_KEY` with a fresh active key (user action).
- Requeue the 169 emails DLQ'd between 2026-08-30 19:24 and the fix.

## Call centre programme (Bwayo) — sequential, one migration each

3. WELILE-CC-FOLLOWUP3 — `cc_followups` table, `cc_raise_park_ticket`, park trigger, promise-loop trigger on `hr_tasks`, `cc_complete_followup`.
4. WELILE-CC-BACKFILL4 — `cc_legacy_outcome_map`, cycle 0 per subject type, legacy backfill into `cc_cycle_rows`/`cc_call_attempts` (+`legacy_note`), freeze legacy call tables.
5. WELILE-CC-ROSTER5 — `cc_cycle_populations`, `cc_open_cycle`, `v_cc_cycle_progress` (security_invoker), `cc_cycle_outstanding`.
6. WELILE-CC-HUB6 — shared Calling Hub UI (tab column sets, reveal-to-create-attempt, WIP guard, outcome recording, cycle controls, follow-ups). No migration.
7. WELILE-CC-METRICS7 — `v_cc_routed_register` (security_invoker) + new `cc_*` metric keys added to the snapshot definitions without touching `hr_compute_snapshots`.

## Call centre programme (Bwayo) — queued 2026-08-31

- ~~WELILE-CC-FOLLOWUP3~~ applied.
- WELILE-CC-BACKFILL4 — legacy outcome map, cycle 0, backfill, freeze legacy call tables.
- WELILE-CC-ROSTER5 — cc_cycle_populations, cc_open_cycle, v_cc_cycle_progress, cc_cycle_outstanding.
- WELILE-CC-HUB6 — shared Calling Hub UI (no migration).
- WELILE-CC-METRICS7 — v_cc_routed_register + new cc_* metric definitions (no change to hr_compute_snapshots).

## 2026-08-31 later additions

- ~~Mailgun back online: verified key, test email to pexpert46@gmail.com, requeued today's parked emails.~~
- ~~Revert Today's capacity strip to the previous UGX-target logic (tenant-count version rejected).~~
- [ ] Agent daily eligibility gate: collected % shown (33%) disagrees with actual 50% collection — align gate math with capacity definition
