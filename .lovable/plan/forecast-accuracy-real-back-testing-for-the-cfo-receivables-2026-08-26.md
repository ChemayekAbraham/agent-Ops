# Forecast Accuracy: real back-testing for the CFO Receivables forecast

## What I verified (current state)

- The forecast does compute an error term, but it is **not a real back-test**. Inside `get_receivables_predictive_forecast` each stream compares one number: the median daily level of days -42..-14 multiplied by 14, against the actual collections of the last 14 days. That checks the *level only* — it does not replay the trend, the day-of-week factors, or the new-origination component that the published forecast actually uses.
- That single error figure (`backtest_mape`) is returned in the payload but **never shown in the UI**. It is referenced only as a type in `src/hooks/useReceivables.ts:215`; no component renders it. The CFO currently sees a quality chip (high/medium/low) whose derivation is invisible.
- There is **no record of past forecasts**: no forecast snapshot or accuracy table exists in the database (only `earning_predictions`, unrelated), and no scheduled job stores what was predicted. So today it is impossible to answer "what did we forecast last month and what came in?"

Conclusion: accuracy is currently asserted, not measured or shown. This plan fixes both.

## Approach

Two complementary sources of truth, both additive:

1. **Walk-forward replay (available immediately).** Collection history is immutable, so the model can be re-run as if standing at earlier dates and graded against what actually came in. This gives a real accuracy record from day one, across the full 182 days of history, using the *same* model that produces the live forecast.
2. **Issued-forecast log (builds the audit trail going forward).** Every forecast the CFO screen produces is snapshotted, then graded automatically once the period closes. This is the genuinely out-of-sample record — it starts empty and fills over time, and it is the version that survives model changes.

## Deliverables

### 1. Back-test RPC — `get_receivables_forecast_accuracy(p_granularity, p_origins, p_horizons)`

Read-only, SECURITY DEFINER, `receivables_guard()`, authenticated + service_role only, same conventions as the existing receivables RPCs.

- Refactors the forecast maths so run-off level/trend/seasonality and origination modelling are computed from an arbitrary "as-at" cut-off, then replays it at a series of past origins (e.g. every week for the last 12 weeks).
- For each origin × horizon (1 day / 7 days / 1 month ahead) it reports forecast vs actual collections, absolute error, percentage error, and whether actual fell inside the published low–high band.
- Aggregates: overall MAPE and bias (are we systematically over- or under-forecasting?), band-hit rate, plus the same metrics per business line and per horizon — so "next week" accuracy is stated separately from "next month".
- Returns the origin-by-origin series so the UI can chart predicted vs actual over time.

### 2. Issued-forecast log

- New table `receivables_forecast_snapshots` (granularity, as-at, period, forecast/run-off/new-origination amounts, low, high, confidence, quality, model version) with grants and RLS restricted to finance/executive roles, plus `actual_amount`, `graded_at`, `abs_error`, `pct_error` filled in later.
- One RPC to record a snapshot (called once per day per granularity, deduplicated on as-at + granularity + period, so opening the dashboard repeatedly does not spam rows) and one scheduled grading routine that fills in actuals for periods that have closed.
- A view/RPC exposing the graded history so the accuracy panel can show measured out-of-sample results as they accumulate.

### 3. CFO UI — Forecast accuracy panel

New `src/components/cfo/ForecastAccuracyPanel.tsx`, mounted with the existing predictive forecast card in `ReceivablesBreakdownForecast`:

- Headline scorecards: accuracy (100 − MAPE) for next-day / next-week / next-month, bias direction, and band-hit rate — each labelled with how many observations it is based on.
- Predicted-vs-actual chart over the replayed origins, actual as a solid line, forecast with its band.
- Per-business-line accuracy table (rent plans, agent advances, credit draws, …), sortable, so the CFO can see which lines are reliable and which are not.
- A clearly separated "Issued forecasts, graded" section showing the real out-of-sample record, with an honest empty state until enough periods have closed.
- Method disclosure: which model version, how many origins were replayed, and the caveat that replay accuracy is optimistic relative to true out-of-sample.
- CSV export of the origin-by-origin table, matching existing export helpers.

Existing quality chips are then wired to the measured figures rather than the crude 14-day proxy, so the chip in the forecast table and the accuracy panel always agree.

## Technical notes

- Forecast maths is extracted into a shared internal function so the live forecast and the back-test cannot drift apart — one model, two callers.
- Nothing existing is modified in behaviour: `get_receivables_total`, `get_receivables_breakdown`, `get_receivables_forecast` and the authoritative Total Receivables card are untouched.
- All amounts UGX via `formatUGX`; every measured figure carries its sample size.
- Replay cost is bounded (origins × horizons capped in the RPC) and the whole thing stays a single round trip per panel.
