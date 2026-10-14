# Architecture Decisions
- R&D report exports accept only project names and dated recorded updates, excluding preset dashboard details so unrecorded claims cannot enter reports.
- Service Centre intake actions use the live typed RPC contract and require its returned request/status before showing success; persistent row errors prevent silent failures.
- Landlord principal comparison is a read-only enabled-role RPC: cumulative non-cancelled float allocations versus non-reversed principal; collected fee totals exclude principal and never add gross fees to their allocation breakdown, preventing double counting.
<!-- LOVABLE:BEGIN -->
- Receivables Analysis uses existing read-only reporting RPCs; aggregate totals outrank sampled items, behavioural runoff excludes new business, and unsupported location forecasts stay unavailable to prevent invented figures.
<!-- LOVABLE:END -->

- Requisition approval errors are normalized client-side only; server authorization is the sole permission authority.
- Four-part repayment validation reconciles Returns + Agent Commission + Platform Fee to Access Fee + Registration Fee (the approved Platform Fee pool).
- CFO 7-day reporting uses Kampala days via `src/lib/kampalaDays.ts`, matching the RPCs.
- Shopping Advance counts/dossiers use one received-transfer ledger helper behind role-gated RPCs; no financial writes.
- Support capacity and its debit use operational float only, so support never drains withdrawable Returns.
- `sofp_ledger_legs` reads advance top-up legs as A10 and emits no X4 for bucket_reclass pairs (CFO approved 2026-10-01).
- `v_agent_daily_eligibility` falls back to LEAST(daily_repayment, outstanding) only when no pinned bill exists today/yesterday.
- CRM call drawer loads one cached role-gated `crm_callee_dossier`; partner visibility is decided server-side.
- CFO TIN/NSSF list derives per paid payroll run (`cfo_statutory_consent_list`).
- CFO correction/evidence tooling (Correction Center, `cfo_s12_save_evidence`, Stage 14 `fin_s14_*`, `cfo_s14b1r/b1w_execute`) is append-only, role-gated and scoped, so review never moves money or touches other users.
- Fingerprinted CFO packages (`cfo_bucket_a_post`, `cfo_corr_5300000_post`) post only via their own function: approver allowlist, own fresh preflight (<30 min), frozen lines, atomic.
- Business-line cost attribution lives in append-only `cfo_reporting_cost_tags`, never correcting journals.
- Rent Plan landlord/LC1 verification (bonus release) fires only on the first Landlord Ops review transition.
- Phone wallet collection runs only for `phone_collection_enabled` plans; late charge only when `smartphone_surcharge_enabled`.
- Agent lending is excluded from company Receivables (agents' own money); Payables mirrors Receivables read-only.
- Merchandise plans count as owed only if `merchandise_plan_recovery_eligible` passes (no phantom receivables).
- Landlord awareness calls store consent + `aware_payout_otp` (not merchant codes) only via append-only `record_awareness_call`; pre-2026-10-08 answers kept via a legacy CHECK branch; never affects approvals.
- Float send-backs auto-complete only when funded/unpaid/open/no payout, via single helper `_complete_allocation_return`; sender can't self-approve; amount edits go through `agent_edit_sent_back_rent_plan`.
- Tenant SMS campaigns send only via `tenant-campaign-sender`, unique `dedupe_key` per tenant, wave stops above 20% failures.
- Landlord payout numbers lock at COO/CFO stage (`lock_landlord_number_at_cfo_stage`); payouts use the approved number.
- Overdue-vetting dialog mounts once in App.tsx from server `get_my_overdue_vetting`; Service Centre shows a banner instead.
- Sign-up client pre-checks run in parallel with a 1.5s cap and fail open; server trigger/edge function remain the only enforcement.
- Subdirectories have their own `AGENTS.md` to read before changing files there: `supabase/AGENTS.md` carries the payout-clock, tenant-classification, payment-score, desk-ordering and smartphone-usage rules — one named function is the only definition and the client never recomputes it.
