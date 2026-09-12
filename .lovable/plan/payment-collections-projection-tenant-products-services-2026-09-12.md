# Payment Collections Projection — Tenant Products & Services

## What this is

A new **Collections Forecast** tab inside Tenant Ops Dashboard > Classic > Workspaces > Tenant Products & Services (beside the existing Projections tab). It projects **how much rent payment money will actually be collected** in future periods, based purely on historical payment trends — no manual growth assumptions, no changes to any existing report, payment, or accounting logic.

## What exists today (verified)

- `v_receivables_collection_history` — the shared server-side definition of observed collections, already used by the CFO predictive receivables forecast.
- `get_receivables_predictive_forecast` — a proven forecasting model (28-day median level + weekly OLS trend, day-of-week factors, holdout-error damping, quality bands) that includes run-off logic you chose **not** to use here.
- `agent_collections` (32 columns incl. `amount`, `created_at`, `reversed_at`) — ~9,500 real payment rows from March–September 2026 (~6 months of history).
- `TenantProductsProjections.tsx` + `useTpspProjection.ts` — the existing 12-month rent-projection tab this new tab sits beside. Untouched.

## Approach

History-based trend only:

1. Read daily collected amounts from `v_receivables_collection_history` (non-reversed collections) over a 365-day lookback.
2. Per day: level = median of the last 28 days, trend = OLS slope on weekly totals, damped by horizon length so far-out projections cannot run away.
3. Day-of-week factors applied when ≥ 60 observed days exist (they do).
4. Honest confidence: projections beyond the observed history span (~6 months) are marked Low confidence with a visible warning; short horizons (days/weeks) can be High/Medium. Confidence ceilings: Low 0.35, Medium 0.6.

## Deliverables

### 1. New server-side RPC (additive, read-only)

`get_payment_collections_projection(p_granularity text, p_periods int)`
- `p_granularity` ∈ `day | week | month | quarter`; SECURITY DEFINER, STABLE, same authorization gate as the other Tenant Ops report RPCs (`ops_tps_report_authorized()`); authenticated + service_role only.
- Returns one JSON payload:
  - `history[]` — observed daily collections for the lookback window (actual vs forecast on one chart).
  - `periods[]` — per future period: `period_start`, `label`, `forecast_amount`, `low`/`high` band, `confidence`, `quality` (High/Medium/Low).
  - `meta` — as-at date (Africa/Kampala), history span, method description, damping factor.
- No hardcoded growth percentages; everything derives from real collection rows.

### 2. Frontend

- `src/hooks/usePaymentCollectionsProjection.ts` — React Query hook following the existing conventions (staleTime, typed payload).
- New `src/components/executive/tenant-ops/CollectionsProjectionPanel.tsx`:
  - Granularity switch: Daily / Weekly / Monthly / Quarterly.
  - Horizon presets: Next 7 days, Next month, Next 3 / 6 / 12 months.
  - Combined actual-vs-forecast chart (recharts, same style as the existing Projections tab) with forecast periods visually distinct (dashed/lighter) from actuals.
  - Per-period table with forecast, low/high band, confidence chip.
  - "How this is calculated" disclosure: method, history span, and an explicit low-confidence warning on long horizons.
  - PDF export matching the existing `tpspProjectionPdf` style (branding, Kampala timestamp, KPIs, period table).
- Mounted as a new **Collections Forecast** tab in `TenantProductsServicesReport.tsx`, lazy-loaded like the existing tabs.

## Guarantees

- Purely additive: no existing RPC, view, KPI, tab, or report is modified; no payment, wallet, ledger, or accounting logic is touched.
- Read-only — the forecast is computed live from real data on every view; nothing is stored.
- Amounts in UGX via `formatUGX`.
