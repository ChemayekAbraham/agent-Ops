# Predictive Receivables Forecast (CFO Receivables)

## What exists today (verified)

- `v_receivables_lines` is the authoritative receivables definition: 9 product streams across Tenant, Agent, Partner, Landlord and Other, with `outstanding_amount`, `due_date`, `due_kind` (`scheduled` / `projected`), `daily_amount`.
- `get_receivables_total` / `get_receivables_breakdown` / `get_receivables_forecast` power `useReceivables.ts` and `ReceivablesBreakdownForecast.tsx` (opened from `ReceivablesCardDrilldown`).
- `get_receivables_forecast` is **not predictive**: it only spreads the *already recorded* book over dates and hard-caps at 400 days. There is no forecast of receivables not yet created.
- Usable history: `agent_collections` runs Mar–Aug 2026 (6 months, ~9,500 rows); `rent_requests` from Jan 2026 (5,524 rows). Repayment history also exists in `business_advance_repayments`, `credit_draw_ledger`, `field_collections`, `merchandise_recovery_deductions`.

Honest constraint: the platform has roughly 6–8 months of usable history. Year 2 / 3 / 4+ figures can only be trend extrapolations, so they must ship with an explicit low-confidence marker rather than being presented with the same weight as next week.

## Approach

Two things are forecast separately and then combined:

1. **Run-off of the existing book** — expected collections from receivables already recorded, adjusted by each stream's *observed* collection rate (actual collected ÷ expected, measured from history), not at face value.
2. **New originations** — receivables expected to be created in future periods, estimated from historical origination volume per business line and its trend.

Each stream (product) is modelled independently, and the method is chosen by what its own data supports:

- **≥ 60 observed days**: seasonal decomposition — day-of-week factors × robust level (median of recent weeks) × trend (Theil–Sen / OLS slope on weekly totals).
- **21–59 days**: robust level × trend, no day-of-week factors.
- **8–20 days**: robust level only (flat).
- **< 8 days**: no number produced — the stream reports `insufficient_data` and is excluded from the total with a visible note.

Longer horizons aggregate the daily model into weeks/months, with the trend damped by a factor estimated from backtest error (not a fixed constant) so multi-year projections don't run away.

**Forecast quality** per stream and overall is computed by walk-forward backtest inside the RPC: hold out the last 14/30 days, run the same model on the earlier window, report MAPE → quality band (High / Medium / Low / Insufficient) plus sample size, lookback and method name. Year-2+ periods are always capped at Low.

## Deliverables

### 1. One new server-side RPC (additive, read-only)

`get_receivables_predictive_forecast(p_granularity text, p_periods int, p_as_at date default null)`
— `p_granularity` ∈ `day | week | month | quarter | year`; SECURITY DEFINER, STABLE, same `receivables_guard()` gate; authenticated + service_role only.

Returns one jsonb payload (single round trip):

- `actual`: current recorded receivables total + `overdue` (lines with `due_date < today`) + `current`, by category.
- `history[]`: observed actual collections per period per stream (so the chart can show actual vs forecast on one axis).
- `periods[]`: for each future period — `period_start`, `period_end`, `label`, `runoff_amount`, `new_origination_amount`, `forecast_amount`, `low`/`high` band, `confidence` (0–1), `quality` band, and `sources[]` (per category → product amounts).
- `streams[]`: per product — method used, sample days, lookback, day-of-week factors present, trend per week, backtest MAPE, `insufficient_data` flag.
- `meta`: as-at, timezone (Africa/Nairobi), history span, damping factor, notes.

Everything derives from the real tables; no hardcoded rates or fixed growth percentages. All aggregation happens in SQL over the full dataset.

### 2. Frontend

- `src/hooks/useReceivables.ts` — add `useReceivablesPredictiveForecast(granularity, periods)` following the existing query/staleTime conventions and typed payload interfaces.
- New `src/components/cfo/PredictiveReceivablesForecast.tsx`:
  - Granularity switch: Daily / Weekly / Monthly / Quarterly / Yearly.
  - Horizon presets: Today, Tomorrow, Next 7 days, Next month, Next 3 / 6 / 12 months, Year 2, Year 3, Year 4+.
  - Three clearly separated states with distinct tokens/badges: **Actual recorded**, **Overdue**, **Forecast (Estimated)** — every predicted number carries a "Forecast" badge and every card shows its quality chip.
  - Combined actual-vs-forecast chart (reusing the `CashflowForecastGraphs` `kind: 'actual' | 'forecast'` pattern) plus a per-period table with run-off / new-origination split.
  - Breakdown by receivable source: Tenant, Agent, Partner, Landlord, Other → product rows, expandable.
  - "How this is calculated" disclosure showing method, sample size, lookback and backtest error per stream, and an explicit warning on multi-year periods.
  - CSV export of the period table, matching existing export helpers.
- Mount as a new tab/section inside `ReceivablesBreakdownForecast` (or beside it in `ReceivablesCardDrilldown`) so the existing Total, breakdown and scheduled-window views stay exactly as they are.

### 3. Guarantees

- No existing RPC, view, hook, KPI or layout is modified; all work is additive.
- Predicted figures never merge into the authoritative Total Receivables card.
- Forecast refreshes off live data — no snapshots or stored predictions — so it updates as new receivable and collection rows land.
- Amounts via `formatUGX`; UGX only.
