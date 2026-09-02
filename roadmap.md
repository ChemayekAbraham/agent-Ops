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
- ~~Agent daily eligibility gate now uses the best of capped coverage and uncapped today/yesterday collection ratio; block message percentage renders correctly.~~

## 2026-08-31 — Funder dashboard

- Funder dashboard funded list must include funded empty houses (self-support houses), not only rent plans.

- [x] Cancel spamming queued emails (purge transactional queue; only 31 Aug failures should have been resent)

- [ ] Clear residual UGX 26 balance for tenant Namuli Roy (+256751149880) — plan completed

## 2026-09-01

- [x] CRM People roster role definitions corrected (tenant = any rent repayment status, agent = agent-ops strict rule + verified sub-agents, landlord = ever received landlord float disbursement)
- [x] My Space salary advance card: show cumulative deducted and pending balance

## 2026-09-01

- ~~Real hang-up for CRM voice calls: `crm-hangup-call` edge function (cancel flag + AT `dequeueInteractiveCall` best-effort drop), wired through `useCancelCall` and `CallDrawer`.~~
- ~~Partner Profile 360 change log: show portfolio code and payment/plan detail changes (rate, payout mode, term, payout day, dates, status) alongside amount before/change/after.~~

- [x] Partner Profile 360 change log: show payout destination details (bank / mobile money) changed from → to
- [x] Verify CRM cancel-call actually drops the leg (crm-hangup-call was never deployed; deployed 2026-09-01)

## 2026-09-01

- ~~Service Centre managers blocked by `HOUSE_VERIFICATION_FORBIDDEN` when passing/returning listings — guard allow list widened (review fields only).~~
- ~~Agent tenant photo re-upload/remove appeared to do nothing when the original photo was uploaded by another agent — added `retire_tenant_document` RPC and wired the UI to it.~~
- ~~"Recommended" badges: primary background + star icon.~~

## 2026-09-01 (later)

- [x] Balance Sheet: split Landlord Float into Company Managed / Self Managed + Total Landlord Float subtotal (presentation only, UI + CSV + PDF)
- [x] Service Centre page still raising HOUSE_VERIFICATION_FORBIDDEN — allow the listing's assigned service centre manager (not only tagged managers) to run the review step

- ~~WELILE-CC-CYCLEDESC21~~ — cycle title (required) + description on `cc_call_cycles`, `cc_open_cycle`, `v_cc_cycle_progress`, cycle controls UI.
- WELILE-CC-MOBILE22 — mobile-first calling hub: sticky bottom bar, reveal sheet with tel: dialing, record/follow-ups sheet, filter sheet. No migration, no data-layer change.

## 2026-09-02
- [ ] Agent/sub-agent overall system counts — answered from dashboard KPI vs activity-union definitions (see user message).
