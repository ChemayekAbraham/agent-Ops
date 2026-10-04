---
name: CFO payables layer
description: Authoritative payables definition (v_payables_lines) + predictive payables forecast and read-only back-test, mirroring the receivables layer
type: feature
---

Server-side, additive, read-only. Guarded by `payables_guard()` (CFO, CEO, COO, Manager, Financial Ops, CTO, Super Admin); anon revoked.

- `v_payables_lines` — the ONLY authoritative payables definition: in-flight withdrawal requests, positive withdrawable wallet balances, supporter returns due, portfolio maturities, landlord payouts, agent-landlord payouts, agent commission payouts, agent float withdrawals, unpaid payroll disbursements.
- `v_payables_payment_history` — shared observed-payment definition (completed/paid withdrawals + platform GL cash-out categories). Never re-declare this union elsewhere.
- RPCs: `get_payables_total`, `get_payables_breakdown`, `get_payables_predictive_forecast(granularity, periods, as_at)`, `get_payables_forecast_accuracy(origins, step_days, horizons)`.

Model mirrors receivables: run-off of the recorded book (28-day median level, weekly OLS trend, DOW seasonality >=60 days, damped, capped at outstanding) plus independently modelled new obligations (observed creation rate x payment rate, ramped over implied settlement term). No hardcoded growth rates — never introduce any. Quality capped against observed history span; multi-year always low.

Frontend: `src/hooks/usePayables.ts`; `PayablesCardDrilldown` (mounted beside `ReceivablesCardDrilldown` in `CFOOverviewDashboard`), `PayablesBreakdownForecast`, `PredictivePayablesForecast`, `PayablesAccuracyPanel` (back-test is read-only, lazy-loaded on expand, no snapshots).
