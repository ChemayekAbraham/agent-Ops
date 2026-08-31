# Active Tasks

1. ~~Self-support house funding confirmation dialog + queue removal~~
   - ~~Add confirmation dialog before "Fund these houses" submits.~~
   - ~~Exclude houses already in `partner_supported_houses` (pending/active) from `agent_list_empty_house_opportunities` so funded houses leave the queue.~~

2. ~~Supported empty-house portfolio approval email~~
   - ~~Wire `self_managed_house` portfolios into the same `partner-self-managed-deployment` template used for rent plans (house lines instead of tenant lines), skipping landlord/agent float SMS.~~
   - ~~Resend for portfolio WSH-9681 (UGX 140,000, SSENKAALI PIUS).~~

## Call centre programme (Bwayo) — sequential, one migration each

3. WELILE-CC-FOLLOWUP3 — `cc_followups` table, `cc_raise_park_ticket`, park trigger, promise-loop trigger on `hr_tasks`, `cc_complete_followup`.
4. WELILE-CC-BACKFILL4 — `cc_legacy_outcome_map`, cycle 0 per subject type, legacy backfill into `cc_cycle_rows`/`cc_call_attempts` (+`legacy_note`), freeze legacy call tables.
5. WELILE-CC-ROSTER5 — `cc_cycle_populations`, `cc_open_cycle`, `v_cc_cycle_progress` (security_invoker), `cc_cycle_outstanding`.
6. WELILE-CC-HUB6 — shared Calling Hub UI (tab column sets, reveal-to-create-attempt, WIP guard, outcome recording, cycle controls, follow-ups). No migration.
7. WELILE-CC-METRICS7 — `v_cc_routed_register` (security_invoker) + new `cc_*` metric keys added to the snapshot definitions without touching `hr_compute_snapshots`.
