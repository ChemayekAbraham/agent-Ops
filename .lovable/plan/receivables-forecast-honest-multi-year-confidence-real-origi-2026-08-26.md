# Receivables Forecast: honest multi-year confidence + real origination modelling

Verification confirmed the forecast is genuinely data-driven (per-stream 28-day median level, weekly OLS trend, day-of-week seasonality, holdout-error damping, no hardcoded growth rates). Two gaps remain, and both are fixed here.

## 1. Multi-year periods must always read as low confidence

Today a period is only forced to `low` quality when it starts more than 365 days out. Because Year 2 begins 1 Jan 2027 (~127 days away), the Year-2 row can currently display `high` or `medium` even though it rests on roughly six months of history.

Change: quality and confidence become horizon-aware relative to available history, not to a fixed 365-day line.

- Any period whose **end** falls beyond the observed history span (currently ~182 days) is capped at `medium`.
- Any period whose end falls beyond twice the history span, or any `year`-granularity period beyond the current year, is capped at `low`.
- Confidence keeps its existing damping but is additionally ceilinged by the same rule, so a `low` band can never show a high confidence number.
- The payload gains `quality_reason` per period (e.g. "beyond observed history span") so the UI can explain the cap instead of just showing a badge.

## 2. New originations forecast from real origination history

Today `new_origination_amount` is a residual: modelled collections minus remaining outstanding. It carries no independent signal about receivables not yet created.

Change: model originations directly, using the same methodology as collections — observed daily history, robust level, weekly trend, damping. No fixed growth percentages.

Origination history per stream, from live tables:

- Tenant rent plans — `rent_requests` newly funded/disbursed value per day (`total_repayment`, dated by `funded_at`/`disbursed_at`).
- Agent advances — `agent_advances` principal per day plus the access-fee stream.
- Agent credit access draws — `credit_access_draws` per day.
- Partner promissory notes — `promissory_notes` amount per day.
- Landlord Welile Homes — `welile_homes_subscriptions` receivable value per day.
- Merchandise recovery — new recovery obligations per day.

For each stream:

- Forecast **new receivables created** per future day from its own origination history.
- Convert created receivables into expected future collections using that stream's **observed collection rate** (collected ÷ expected, measured from history) and its own repayment cadence, so a newly originated plan collects over time rather than instantly.
- `runoff_amount` stays the run-off of the already-recorded book (unchanged definition); `new_origination_amount` becomes this modelled figure instead of a residual.
- Streams with fewer than 8 observed origination days report zero new origination and are listed with a reason, exactly as collection streams already are.

Because originations are now independent, near-term totals may shift slightly upward versus today's residual approach; this is intended and expected.

## Technical notes

- One additive migration replacing `get_receivables_predictive_forecast` (same signature, same `receivables_guard()` gate, `SECURITY DEFINER`, `STABLE`, anon revoked). No other RPC, view or authoritative total is touched.
- Payload additions only: `quality_reason` per period; `origination` block inside each `streams[]` entry (method, sample days, level, trend, collection rate); `origination_only_streams` for streams lacking origination history. All existing keys keep their meaning, so nothing breaks.
- `src/hooks/useReceivables.ts` — extend the `PredictiveForecast` / `PredictivePeriod` / stream interfaces with the new optional fields.
- `src/components/cfo/PredictiveReceivablesForecast.tsx` — show `quality_reason` next to the quality chip, add the origination model rows to the "How this is calculated" disclosure, and add an explicit note on multi-year rows that they are extrapolation beyond the available history.
- Amounts stay UGX via `formatUGX`; forecast amounts stay visually distinct from actual and overdue.
- Verify after applying: authenticated RPC call for `day`, `month` and `year` granularities; confirm Year-2 and Year-3 rows report `low`, that new-origination figures reconcile to independently recomputed origination history, and that typecheck and build pass.
