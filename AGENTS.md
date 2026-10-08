# Architecture Decisions
<!-- LOVABLE:BEGIN -->
- Receivables Analysis uses existing read-only reporting RPCs; aggregate totals outrank sampled items, behavioural runoff excludes new business, and unsupported location forecasts stay unavailable to prevent invented figures.
<!-- LOVABLE:END -->

- Requisition approval errors are normalized only in the client; server authorization remains the sole permission authority.
- Four-part repayment validation reconciles Returns + Agent Commission + Platform Fee to Access Fee + Registration Fee, because those two stored fee components form the approved Platform Fee pool.
- CFO 7-day reporting labels and day buckets use Kampala (EAT, UTC+3) calendar days through `src/lib/kampalaDays.ts`, matching the reporting RPCs; browser-local dates shifted cards by a day.
- Shopping Advance qualification (distinct outbound peer-transfer senders, legacy + ledger) and user dossiers come from role-gated server functions, so legacy transfers count and limits aren't mistaken for issued credit.
- Support capacity and its funding debit use operational float only (`funder_support_capacity` = `funder_float_available`), so support can never drain withdrawable Returns.
- Balance Sheet (`sofp_ledger_legs`) reads advance top-up company legs as Agent Advance Receivable (A10) and emits no synthetic X4 lines for bucket_reclass_in/out pairs, because top-ups move no bank cash and reclass pairs already balance (CFO approved 2026-10-01).
- `v_agent_daily_eligibility` falls back to LEAST(daily_repayment, outstanding) for counted daily/lapsed-weekly plans only when the agent has no pinned bill today/yesterday, because counted plans with no bill row showed a UGX 0 target.
- The CRM call drawer paints directory identity immediately, then loads one cached role-gated dossier (`crm_callee_dossier`); partner visibility (partner_ops/super_admin/hr only) is decided server-side.
- The CFO staff TIN/NSSF list derives per paid payroll run (`cfo_statutory_consent_list`) and pushes on the `paid` payroll event, so the list reappears each cycle without polling.
- CFO Correction Center reads/writes only evidence-review tables via role-gated functions (`cfo_save_evidence_review` + append-only audit); Approve is recorded but never executed, so review can never move money.
- `cfo_s12_save_evidence` accepts evidence files only inside the owning collection's folder of the private `collection-evidence` bucket, so evidence can't be cross-attached or point outside storage.
- Stage 14 evidence recovery writes only `fin_s14_cases`/`fin_s14_evidence`/`fin_s14_audit` via `cfo_s14_add_evidence`/`cfo_s14_decide`, asserting Stage 11/12 control totals and zero financial-table writes; everything is append-only, so case resolution can never move money.
- Rent Plan writes verify a linked landlord or LC1 (releasing registration bonuses) only on the first Landlord Ops review transition (review date NULL → set), because generic status writes were releasing bonuses.
- Batch 1 restoration (`cfo_s14b1r_execute`) counts only its 13 frozen `fin_s14b1r_lines`; the stored-balance refresh runs solely via `cfo_s14b1w_execute` with a single-use fingerprinted CFO approval, so corrections can't inflate balances or touch other users.
- Phone wallet collection runs only for plans with `phone_collection_enabled` (daily `recover_smartphone_from_wallets`), one plan at a time; it may draw advance-locked funds (withdrawals stay locked); the late charge runs only when `smartphone_surcharge_enabled` is on.
- Agent lending remains excluded from company Receivables totals and forecasts because it is agents' own money; the Receivables sidebar now exposes the company Forecast instead of the separate lending section.
- Payables mirrors Receivables with read-only payable hooks; its single Forecast view preserves obligations and payment rules.
- Merchandise/phone/bike plans count as owed or recoverable only if `merchandise_plan_recovery_eligible` passes, because pending orders created phantom receivables.
- Business-line cost attribution of already-posted payments lives in append-only `cfo_reporting_cost_tags` (one tag per ledger group per line), never in correcting journals, so reports re-attribute costs without double counting.
- Bucket A agent-receivables corrections post only via `cfo_bucket_a_post` after a fresh passed `cfo_bucket_a_preflight` by the same CFO approver, against frozen fingerprinted `cfo_bucket_a_package_lines`; all lines post atomically or none, so no partial or double posting.
- Tenant SMS campaigns (`tenant_campaigns` + waves/sends/clicks) send only via `tenant-campaign-sender`, one row per tenant per campaign (unique `dedupe_key`), stopping a wave above 20% failures and unscheduling its own cron after the last wave, so no tenant is messaged twice and nothing keeps running.
- Landlord phone/MoMo/approved numbers are locked by trigger `lock_landlord_number_at_cfo_stage` once any open Rent Plan reaches COO/CFO review or funding (released only if cancelled/rejected/completed); payouts always use the approved number, so a differing contact number no longer blocks the OTP.
