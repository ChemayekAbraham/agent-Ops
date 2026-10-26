# 249 — CTO-controlled Rent Plans: collections tracker (2026-10-24)

**Status: MIGRATION WRITTEN, NOT APPLIED (Josh applies by hand).** The UI is built and reads the database through the new RPCs; until
`20261024130000_cto_controlled_rent_plans.sql` is applied the panel shows its error state.

Read this before touching `cto_controlled_rent_plans`, `get_cto_controlled_plan_collections`, or the CTO dashboard home tab.

## What it is

A panel on the **CTO dashboard home tab** (`CtoControlledPlansPanel`, mounted under the fake-account radar) that tracks collections per
Rent Plan, **only for plans the CTO controls**. It shows what each plan was given, what is due, and what has come back, with what came
back split into principal, Partner, agent and platform.

No marker for "CTO-controlled" existed. It is a new table, backfilled with the 54 plans funded 19-24 Oct 2026.

## Backend (`supabase/migrations/20261024130000_cto_controlled_rent_plans.sql`)

| Object | What it does |
|---|---|
| `cto_controlled_rent_plans(rent_request_id pk -> rent_requests, added_by, added_at, note)` | The list. RLS on. `authenticated` may SELECT only if CTO, CEO or CFO. No insert/update/delete policy: writes go only through the RPCs. `service_role` has all four grants, `anon` none. A restrictive `mfa_required_for_staff` policy matches the other staff tables. |
| `cto_add_controlled_plans(uuid[], text)` / `cto_remove_controlled_plans(uuid[])` | **CTO role only. Not even a super admin** (tightened by `20261025100000`; `20261024130000` first allowed CTO or super admin). Idempotent (adding twice adds 0). Each writes one `audit_logs` row (`cto_controlled_plans_added` / `_removed`). Returns how many rows changed. |
| `get_cto_controlled_plan_collections()` | SECURITY DEFINER, CTO/CEO/CFO only. One row per plan (`row_kind = 'plan'`) plus one `row_kind = 'summary'` row of totals. |
| `cto_search_rent_plans(text, int)` | Read-only plan search for the "Manage CTO plans" dialog (tenant name, phone or agent name, 2+ characters, 25 rows), with a `controlled` flag. Funded/repaying/completed plans only. |

The backfill selects `coalesce(funded_at, disbursed_at) >= '2026-10-19' and < '2026-10-25'` with status in `funded`, `repaying`,
`completed`. The upper bound keeps it to exactly the 19-24 Oct set (54 plans) whenever the migration is applied.

### The numbers

Per plan:

- `given` = `rent_amount`; `formula_due` = `compute_rent_repayment(rent_amount, duration_days).total_repayment`; `recovered` = `rent_requests.amount_repaid`.
- `collection_count`, `last_collection_on` from `agent_collections` where `reversed_at is null`.
- The ledger split comes from `general_ledger` rows with `source_table = 'agent_collections'` and `source_id` = the collection id, for collections not reversed:
  - `partner_earned` = category `partner_returns_allocated`
  - `platform_earned` = `platform_fee_collected`
  - `agent_commission` = `agent_commission_payable` + `agent_commission_earned`, **direction `cash_in` only** (the payable account also has `cash_out` rows for payouts; they are not earnings)
  - `fees_drawn` = `treasury_fee_drawdown` (read as cash_out minus cash_in)
  - `principal_back` = collections − `fees_drawn`
- `expected_partner` = 0.15 × given × days / 30; `expected_agent` = 0.10 × `formula_due`.
- `days_overdue` = days past (funded date + duration) while `recovered < formula_due`, else 0.
- `counter_mismatch` = the plan's collections do not add up to `amount_repaid`.

Verified against production on 2026-10-24 (read inside a rolled-back transaction): 54 plans, given 43,920,000, due 59,841,584,
recovered 2,361,301 (= the collections ledger, **0 counter mismatches**), partner 260,987, platform 124,118, agent 236,129, fees drawn
621,234, principal back 1,740,067. `partner + platform + agent` equals `fees_drawn` exactly, so
`recovered = principal_back + partner + agent + platform`: the stacked bar adds up. No plan was overdue yet (all funded within the last 30 days).

## Frontend (UI only reads and calls the RPCs)

- `src/lib/ctoControlledPlans.ts` types and pure helpers (roll-up by agent, default order, `UGX 1,234,567` formatting).
- `src/hooks/useCtoControlledPlanCollections.ts` React Query hook. **Deliberately not cached:** `staleTime: 0`, `gcTime: 0`, refetch every
  30 s and on window focus. Balances and totals must not be stale. Also `useCtoPlanSearch` and the add/remove mutations.
- `src/components/cto/CtoControlledPlansPanel.tsx` stat tiles, stacked bar (principal / Partner / agent / platform), sortable and filterable
  table (default order: days overdue, then largest balance), per-agent roll-up, "Manage CTO plans" dialog, "Download PDF", empty / loading / error states.
- `src/lib/ctoControlledPlansPdf.ts` the PDF (summary + split, per agent, per plan), same landscape layout as the other Welile reports.

## Things that will bite

- **`formula_due` is the Rent Plan formula, not the stored `total_repayment`.** For normal plans they are equal. For `outstanding_balance`
  plans the stored total is the typed balance and differs, so `% recovered` would not match what the tenant sees. The 54 backfilled plans are all new plans.
- **The ledger split needs collections that carry ledger rows.** A collection with no ledger rows (an old one, or one posted before the split
  existed) counts toward `recovered` but adds nothing to Partner / agent / platform, and its whole amount lands in `principal_back`.
- **`counter_mismatch` is a signal, not a fix.** It appears when `amount_repaid` was edited by hand (see the Kwenseri balance correction, which
  moved plan totals, not repaid) or a collection was reversed without the counter following. Investigate with `v_rent_repaid_reconciliation`.
- **Adding a plan to the list changes no money.** The list is only a filter for this panel.
- Write access is the CTO role only (`20261025100000`), so a super admin who is not CTO is refused. Reading stays CTO, CEO and CFO. If it must be limited to one person, use `is_platform_owner()` (20261024110000). Anyone who can assign roles could give themselves the CTO role; that is outside this feature.

## Plans join the tracker when the CTO allows their landlord payout (`20261025110000`)

A trigger on `withdrawal_requests.landlord_block_exempt_at` (empty to set) adds the payout's Rent Plan (`landlord_payouts.rent_request_id`) to
`cto_controlled_rent_plans` with the note "Allowed to the payout queue by the CTO". It covers **both** routes (Allow selected, and Allow with
exception), because both set that marker. Rules:

- Only when the person who allowed it holds the **CTO role** (`landlord_block_exempt_by`, or the signed-in user on the exception route, which does not record one). A payout allowed by the CFO or a super admin is not added.
- Plans already on the list are left alone; an audit row (`cto_controlled_plans_added`, source `allowed_to_payout_queue`) is written for new ones.
- The trigger never blocks allowing a payout: errors inside it are warnings only.
- **Forward only.** 335 payouts were allowed 25 Sep to 22 Oct, 294 of whose plans are not on the list. A commented backfill at the bottom of the migration adds them (changes the tracker totals); it is not run.

## Roll back

`supabase/rollbacks/20261024130000_cto_controlled_rent_plans.rollback.sql` drops the four functions and the table. The UI then shows its error state.
