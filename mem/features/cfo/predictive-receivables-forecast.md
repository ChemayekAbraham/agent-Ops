---
name: Predictive receivables forecast
description: CFO predictive receivables forecast RPC + UI — per-stream run-off and origination models from real history, honest horizon-capped confidence, no hardcoded growth rates
type: feature
---

`get_receivables_predictive_forecast(p_granularity, p_periods, p_as_at)` (SECURITY DEFINER, STABLE, `receivables_guard()`, anon revoked) returns one JSON payload:
`actual`, `history`, `periods` (runoff vs new origination, low/high, confidence, quality, `quality_reason`), `streams` (incl. nested `origination` model), `scheduled_only_streams`, `origination_only_streams`, `meta`.

Two independently modelled components — never a residual:
1. **Run-off of the recorded book** — per category+product dense daily collection history (365d lookback) from `agent_collections`, `field_collections`, `agent_advance_ledger`, `credit_draw_ledger`, `merchandise_recovery_deductions`, `subscription_charge_logs`, `business_advance_repayments`; 28-day median level + weekly OLS trend damped by holdout error and horizon; day-of-week factors when >=60 observed days; cumulatively capped at outstanding.
2. **New originations** — daily new-receivable level + weekly trend from origination tables (`rent_requests` disbursed/funded, `agent_advances` principal + access fee, `credit_access_draws`, `promissory_notes`, `welile_homes_subscriptions`, `subscription_charge_logs`), multiplied by the stream's **observed collection rate** (collected ÷ originated over the same lookback), ramped over its implied collection term, bounded at 3x observed level to stop runaway long horizons.

Honest confidence: quality is capped against the observed history span (`meta.history_span_days`). Horizon beyond the span can never be `high`; beyond 2x the span, and every future calendar year, is forced `low` with an explicit `quality_reason`. Confidence ceilings: low 0.35, medium 0.6.

No hardcoded growth percentages — never introduce any. Frontend: `useReceivablesPredictiveForecast` in `src/hooks/useReceivables.ts`; `src/components/cfo/PredictiveReceivablesForecast.tsx`. Authoritative receivables totals (`get_receivables_total`) untouched.

## Real back-testing (2026-08-26)

- `v_receivables_collection_history` is the single shared definition of observed collections; both the forecast and every accuracy measure read it (never re-declare the union).
- `get_receivables_forecast_accuracy(p_origins, p_step_days, p_horizons)` performs **walk-forward replay**: it calls `get_receivables_predictive_forecast('day', h+1, <past origin>)` so the model only sees data available at that origin, drops the origin day (leak guard), and grades the modelled component against actual collections. Reports accuracy, MAPE, bias, band-hit rate per horizon and per business line.
- Issued-forecast track record: `receivables_forecast_snapshots` (unique on granularity+as_at+period_start), written by `record_receivables_forecast_snapshot` (cron `snapshot-receivables-forecast`, also callable from the UI) and graded by `grade_receivables_forecast_snapshots` (cron `grade-receivables-forecast`). Read via `get_receivables_forecast_snapshot_accuracy`.
- Known caveat, stated in the UI: replay reads outstanding balances as of today, so replayed accuracy is a slightly optimistic upper bound. The snapshot log is the unbiased record.
- Baseline measured on 2026-08-26 (8 origins, weekly step): next-day 64.9%, next-7-day 59.8%, next-30-day 74.0% accuracy, with a persistent negative bias (the model under-forecasts).
- UI: `src/components/cfo/ForecastAccuracyPanel.tsx`, mounted under `ReceivablesBreakdownForecast`.
