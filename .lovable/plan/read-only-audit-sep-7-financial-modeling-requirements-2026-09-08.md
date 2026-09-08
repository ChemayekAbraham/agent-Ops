# Read-only audit — Sep 7 financial-modeling requirements

No code, migration, data, config or deployment was changed. All findings below come from the current repo and live database reads.

## Headline correction to the runbook

`docs/phase2-deployment-runbook.md` claims M1 was dropped and M2–M4 were never applied. **That is out of date.** The live database already has all of them:

| Function (live) | Signature |
|---|---|
| `recognise_funding_treasury` | `(p_rent_request_id uuid)` SECURITY DEFINER |
| `assert_funding_treasury_recognised` | `(p_rent_request_id uuid)` |
| `record_rent_request_repayment_v2` | `(p_tenant_id, p_amount, p_source_table, p_source_id, p_transaction_group_id)` |
| `treasury_waterfall_go_live` / `_at` | no args, both `2026-09-08 00:00:00+00` |
| `is_treasury_waterfall_scope` | `(p_rent_request_id uuid)` |
| `post_instalment_waterfall`, `allocate_instalment` | live |

`rent_pricing_floor_effective_from()` = `treasury_waterfall_go_live()` = `2026-09-08 00:00:00+00`, so the single-boundary migration (20260908140000) is in force. None of these versions appear in `supabase_migrations.schema_migrations` — they were applied directly, so the migrations table is not evidence of state in either direction.

## Requirement-by-requirement verdict

### 1) Per-manager/agent real-funds balance — PARTIAL
`get_money_at_bank_reconciliation()` / `get_money_at_bank_total()` are live and role-gated (cfo, coo, manager, super_admin, operations, financial_ops). They compute in/out/banked with a `2026-09-07 00:00:00+03` cutoff and expose row detail. **But the custodian is hardcoded**: classification requires `normalized_text ~ 'dear (bayo|mercy|...)'` AND `from_email ~ '@equitybank'`. There is no per-custodian dimension, no second manager, no MoMo custodian. UI: `src/components/financial-ops/BankEmailReconciliationPanel.tsx`.

### 2) Agent/merchant transactions from bank data — PARTIAL
Inbound/outbound classification exists inside the same function (`looks_credit`, `looks_debit`, `sent_to_her`, `extracted_counterparty`), fed by `gmail_transactions` where `channel='bank'`; `counterparty_name` was added by `20260908090000_add_gmail_transactions_counterparty_name.sql`. Ledger-side actions are folded in for `cfo_direct_credit` / `financial_ops_manual_entry`. Gaps: an `ambiguous` bucket exists by design, counterparties are regex-extracted strings not linked to agent/merchant user ids, and outbound transfers are not attributed to a specific merchant agent record.

### 3) Treasury separate from Landlord Float — LIVE (structurally), unexercised
`ledger_account_catalog` has `L7 — Platform Treasury Control — Landlord Flow` (current_liability) with 2 entries in `ledger_account_map`. The migration explicitly rejects A1/A2/A5 (cash) and L4 (landlord obligation), so Treasury is distinct from Landlord Float by construction. Only **1** L7 leg exists live: UGX 940,292 `treasury_fee_recognised`, "BD-3 subsidy credited to Landlord Flow Treasury control", 2026-09-07. `treasury_control_account` is not a table (correctly — it is a GL account). `instalment_allocations` exists with **0 rows**.

### 4) 50% performance threshold before creating a partnership account — NOT BUILT
A 50% rule exists but for a different purpose: `compute_agent_performance(uuid)` counts a tenancy "healthy" at `collected_30d / expected_30d >= 0.50` and returns `healthy_ratio`. Its only callers are the agent limit-engine functions (migrations 20260422070237, 20260720115417). No partner/partnership creation path references it — `src/pages/RegisterPartnerPublic.tsx`, `src/pages/AgentPartners.tsx` and `src/components/manager/CreateInvestmentAccountDialog.tsx` contain no performance gate.

### 5) Merchant recognition excluding money-managing operators — NOT BUILT
`is_merchant_agent(p_user_id)` is `EXISTS (SELECT 1 FROM cashout_agents WHERE agent_id = ... AND is_active)` — nothing else. Live: **15** active merchant agents, of which **4** also hold a manager/operations/financial_ops/cfo/coo/super_admin role. Those four are today classified as merchant agents. There is no exclusion list and no "company-funds custodian" flag.

### 6) Repayment distribution (principal + 10% agent + 15% partner allocation) — PREPARED, LIVE-BUT-DORMANT
`record_rent_request_repayment_v2` is live and does exactly what the doc describes: scope check, `assert_funding_treasury_recognised`, delegate to the existing `record_rent_request_repayment`, then `post_instalment_waterfall` when in scope, else return `legacy_path_no_waterfall`. Partner Reward is attribution-only (no L3 payable) per `docs/landlord-flow-waterfall.md`; agent commission is the only payable (L5); R1 = Treasury less agent commission. **Dormant because**: 0 rows in `instalment_allocations`, and the only caller of `_v2` is `supabase/functions/tenant-pay-rent/index.ts:184`, whose deployed state is unverified.

## Claimed blockers and artifacts

| Item | Verdict |
|---|---|
| `docs/landlord-flow-waterfall.md`, `docs/phase2-deployment-runbook.md` | Present. Runbook's "not applied" status is stale (see above). |
| 20260907210000–212500 (Treasury/allocations/dimensions/controls/G7 monitor) | Effects live: L7 catalog + maps, `instalment_allocations`, `v_g7_receivable_direction_defect` all exist. |
| 20260908100000 / 100500 / 101000 (BD-4 floor, waterfall, BD-3) | Live: floor date function returns the boundary; `post_instalment_waterfall` exists; the single L7 leg is a BD-3 subsidy. |
| **20260908101500_g7_collection_direction_fix.sql** | **PREPARED-BUT-NOT-APPLIED, confirmed.** `agent_allocate_tenant_payment_internal` still contains `rent_receivable_created` (found at char 3781). Every agent collection still debits A3. |
| 20260908120000 / 120500 / 130000 / 140000 (M1–M4) | **LIVE.** |
| `.github/workflows/deploy-edge-function.yml` | Present, `workflow_dispatch` only, two-item choice list, typed DEPLOY confirm, `config.toml` verify_jwt pre-flight. No push/PR trigger. |
| `SUPABASE_ACCESS_TOKEN` / deploy path | Absent in this environment (`TOKEN_ABSENT`); `build.yml` contains no supabase reference. Repository-secret presence on GitHub cannot be read from here. |
| `cycles_disbursed`, `accrual_mode`, `cfo_float_cycles_disbursed` | **NOT LIVE.** No such columns in any `public` table. `landlord_float_buckets` does not exist. The 20260907150000/160000/180000 float-bucket migration files are repo-only in this respect. |
| Option A backfill | **Still blocked, confirmed by design not just by doc.** Legacy fees were recognised only in `fee_revenue_ledger`, never decomposed in `general_ledger`, and `instalment_allocations` has 0 rows — there is no allocation history to reconstruct. The 688 legacy plans stay on the legacy path under Option B. |

Also relevant: `rent_requests` currently has **0** rows with `repayment_frequency='weekly'`, so the weekly-eligibility work has no live population exercising it.

## Recommended execution sequence (phases, nothing implemented)

**Phase 0 — reconcile the record (no money).** Correct `docs/phase2-deployment-runbook.md` to reflect that M1–M4 are live and that the float-bucket columns are not. Add a live-state verification query block. Zero risk, prevents a second engineer re-applying M1–M4.

**Phase 1 — G7 in a controlled window (highest value, contained).** Apply `20260908101500` after its own three pre-checks: confirm `auto_assign_ledger_scope()` does not override scope for `tenant_repayment`, dry-run one collection inside `BEGIN … ROLLBACK` verifying both raw-direction and mapped DR/CR controls, then confirm the collection path end to end. Prospective only; the 10,774 historical legs stay visible in `v_g7_receivable_direction_defect`. Historical remediation is a separate append-only phase, later.

**Phase 2 — activate the waterfall behind the existing boundary.** Add `SUPABASE_ACCESS_TOKEN` (Edge-Function deploy scope only, CI-owned identity), deploy `fund-agent-landlord-float` **first**, reconcile L7 against one funding event, then deploy `tenant-pay-rent`, run one canary instalment and reconcile the 33,333 / 667 / 11,000 split and R1 = Treasury − commission. Gate each step.

**Phase 3 — custodian dimension (requirements 1 and 2).** Replace the hardcoded Bayo/Equity predicate with a custodian registry keyed to user ids, then re-express `get_money_at_bank_reconciliation` per custodian and link `gmail_transactions.counterparty_name` to agent/merchant ids. Reporting-only; no ledger writes.

**Phase 4 — merchant recognition (requirement 5).** Add an explicit exclusion for company-funds custodians and tighten `is_merchant_agent`, after deciding the treatment of the 4 current overlaps — that is a business call, not a code call, because it changes who can be paid as a merchant.

**Phase 5 — partnership creation gate (requirement 4).** Reuse `compute_agent_performance().healthy_ratio >= 0.50` server-side at partner-account creation. Do it last: it blocks a growth path, so it should not land while collection numbers are still being corrected by Phases 1–3.

Historical G7 remediation and Option A backfill remain out of scope until the fees-already-collected split is settled as a business decision.
