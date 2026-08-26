# Receivables Breakdown & Forecast (CFO Home)

## What I found first (inspection report)

**There is no single authoritative Total Receivables today — there are four competing figures.**

1. **Ledger (real source of truth).** `get_statement_of_financial_position()` builds the Balance Sheet from `sofp_ledger_legs()` mapped through `ledger_account_catalog`. Two receivable accounts exist:
   - `A3` Rent Access Receivables (Tenants) — net ≈ 817.7M (categories: `rent_receivable_created` +819.4M, `tenant_repayment`, `rent_repayment`, `pool_rent_deployment`, `agent_float_used_for_rent`)
   - `A4` Advances and Other Receivables — net ≈ −1.21B (dominated by `wallet_deduction_general_adjustment` −720M and `wallet_deduction` −512M, plus `rent_disbursement` +44.7M, `agent_repayment` −24.3M)
   A4 being deeply negative means historic wallet-deduction legs are posted against the receivable account; this is a real classification issue the new section must expose, not hide.
2. **CFO Home KPI "Money We're Owed"** — `src/hooks/useCFOOverviewData.ts:353-396`: `subscription_charges.accumulated_debt` + active `agent_advances.outstanding_balance`. Ignores business advances, credit draws, promissory notes, rent_requests.
3. **Balance-sheet panel hook** — `src/hooks/useFinancialStatements.ts:662-716`: rent_requests rent_amount (funded/disbursed/repaying) + `rent_receivable_created` ledger category + unpaid advance access fees + promissory notes outstanding, with AR aging + bad-debt provision.
4. **Daily/detail panels** — `useCFODailyReceivablesPayables.ts` (from `v_tenant_daily_eligibility` + `agent_collections`) and `CFOReceivablesTracker.tsx` (rent_requests funded − repaid).

**Receivable-bearing tables** (with due-date field): `rent_requests` (derived from `start_at`/`funded_at` + `daily_repayment`), `agent_advances` (`expires_at`), `business_advances` (`disbursed_at`, `last_compounded_date`), `credit_access_draws` (`expires_at`), `promissory_notes` (`next_deduction_date`, `deduction_day`), `welile_homes_subscriptions` (`next_due_date`, `receivable_total`, `outstanding_balance`), `subscription_charges` (`accumulated_debt`), `landlord_float_receivables`, `merchant_out_of_pocket` claims, `product_orders` / `merchandise_sales` + `merchandise_recovery_plans`.

**Collection history**: `agent_collections`, `field_collections`, `business_advance_repayments`, `credit_draw_ledger`, `subscription_charge_logs`, `merchandise_recovery_deductions`, plus ledger repayment categories.

**Existing categorisation**: `src/lib/incomeStatementServiceMap.ts` already maps ledger categories into Rent / Agent / Partner / Landlord "Products & Services" families — reuse it, do not invent a second map.

**Existing forecast patterns to copy**: `ROIPayableForecast.tsx` (bucket by next due date), `CashflowForecastGraphs.tsx` (`kind: 'actual' | 'forecast'`, presets + custom range), `LiquidityForecastPanel.tsx`. Nothing forecasts receivables inflow today.

## Approach

Anchor on the ledger: **Total Receivables = A3 + A4 net from `get_statement_of_financial_position()`** (the same figure the Balance Sheet shows). The new section reconciles operational sub-ledgers up to that ledger figure and flags the gap instead of forcing a match.

### 1. One new DB RPC (read-only, additive)
`get_cfo_receivables_breakdown_forecast(p_as_at timestamptz default now())` — SECURITY DEFINER, STABLE, same role gate as the SOFP RPC (cfo/ceo/coo/manager/financial_ops/super_admin/cto). Returns jsonb:

- `ledger_total`: `{ a3, a4, total, source }` from `sofp_ledger_legs`.
- `categories[]`: five buckets — Agent, Landlord, Partner, Tenant Products & Services, R&D — plus `unclassified`. Each carries `outstanding`, `count`, and `items[]` (product/service name, counterparty name, amount, due_date, status, source_table). Mapping is by source table + ledger category via `incomeStatementServiceMap` families mirrored in SQL; anything unmapped goes to `unclassified`.
- `reconciliation`: `{ categories_total, ledger_total, difference, ties_out }` — `ties_out` false when |difference| > 1 UGX; never adjusted silently.
- `schedule[]`: confirmed/scheduled rows with real contractual due dates (`rent_requests` daily schedule, `agent_advances.expires_at`, `business_advances`, `credit_access_draws.expires_at`, `promissory_notes.next_deduction_date`, `welile_homes_subscriptions.next_due_date`), each `{ due_date, amount, category, product, counterparty, status, basis:'scheduled' }`.
- `projected[]`: only where ≥ 8 collection events exist in the last 90 days for that stream (from `agent_collections`/`field_collections`/repayment tables); computed as median observed daily collection × days in the horizon, tagged `basis:'projected'` with `sample_size` and `lookback_days`. Streams below the threshold return `insufficient_data: true` and **no number**.

### 2. Frontend
- `src/hooks/useCFOReceivablesForecast.ts` — single query wrapper (staleTime 5 min, no window-focus refetch).
- `src/components/cfo/ReceivablesBreakdownForecast.tsx` — full section: category cards (expandable to the item table), reconciliation banner (green tie-out / red flag with the exact difference), forecast view with periods Today, Tomorrow, Next 7 days, Next month, Next 3 / 6 months, Next year, Custom range (existing `Calendar` + `Popover` pattern), Scheduled vs Projected split shown as distinct badges/colours, and "Insufficient data to project" where applicable.
- `src/components/cfo/ReceivablesSummaryStrip.tsx` — the only thing added to the home page: Total Receivables, Due Today, Due Tomorrow, Due This Week, Expected Next Month, plus a "View Receivables Forecast" drill-in that opens the full section in the existing sheet/drilldown pattern.
- Mount the strip in `CFOOverviewDashboard.tsx` directly under `DailyReceivablesPayablesSection` (line ~238). Nothing else on the page is touched.

### 3. Guarantees
- No existing hook, KPI, ledger calculation, or layout is modified.
- No placeholder or hardcoded amounts; every figure traces to a table/ledger leg named in the payload's `source` fields.
- Sums are validated against the ledger and flagged, never plugged.
- Amounts formatted with `formatUGX`.

## Note for you
The existing home KPI "Money We're Owed" (#2 above) will not equal the new ledger-anchored Total Receivables, because it only counts subscription debt + agent advances. I will leave that KPI untouched and surface the difference inside the reconciliation banner so the discrepancy is visible rather than reconciled away.
