---
name: Predictive receivables forecast
description: CFO predictive receivables forecast RPC + UI — per-stream models from real collection history, no hardcoded growth rates
type: feature
---

`get_receivables_predictive_forecast(p_granularity, p_periods, p_as_at)` (SECURITY DEFINER, STABLE, `receivables_guard()`, anon revoked) returns one JSON payload:
`actual` (total / overdue / not_yet_due / categories from `v_receivables_lines`), `history` (bucketed observed collections), `periods` (forecast with runoff vs new origination, low/high band, confidence, quality), `streams` (model transparency), `scheduled_only_streams`, `meta`.

Method: per category+product dense daily history (365d lookback) from `agent_collections`, `field_collections`, `agent_advance_ledger`, `credit_draw_ledger`, `merchandise_recovery_deductions`, `subscription_charge_logs`, `business_advance_repayments`. 28-day median level + weekly OLS trend, damped by holdout error and horizon distance; day-of-week factors when >=60 observed days. Streams with <8 observed days are excluded from modelling and fall back to contractual due dates. No hardcoded growth percentages — never introduce any.

Frontend: `useReceivablesPredictiveForecast` in `src/hooks/useReceivables.ts`; `src/components/cfo/PredictiveReceivablesForecast.tsx` mounted at the bottom of `ReceivablesBreakdownForecast`. Forward amounts must always be labelled Forecast/estimated and stay visually distinct from actual and overdue receivables. Authoritative receivables totals (`get_receivables_total`) are untouched.
