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
