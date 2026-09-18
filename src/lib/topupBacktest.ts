/**
 * Backtest for the top-up prediction model.
 *
 * Mirrors the model inside `get_partner_ops_returns_forecast`: a baseline of the
 * last N completed periods of real top-ups, plus a damped trend (half the gap
 * between the recent half and the older half of that window), projected one
 * period ahead.
 *
 * Backtesting replays that model over completed periods only, using nothing but
 * the periods that came BEFORE the one being predicted, then compares the
 * prediction against what was actually received.
 */

export const BACKTEST_BASIS = 6;
/** Fewer prior periods than this cannot support a prediction. */
export const BACKTEST_MIN_BASIS = 2;

export interface TopupHistoryPeriod {
  key: string;
  label: string;
  is_past: boolean;
  topups: number;
}

export interface TopupBacktestRow {
  key: string;
  label: string;
  /** Number of prior completed periods the prediction was built from. */
  basis: number;
  predicted: number;
  actual: number;
  /** actual − predicted (positive = received more than predicted). */
  variance: number;
  /** |variance| / actual, as a percentage. Null when actual is zero. */
  errorPct: number | null;
}

export interface TopupBacktestSummary {
  rows: TopupBacktestRow[];
  predictedTotal: number;
  actualTotal: number;
  /** Mean absolute percentage error across rows with a non-zero actual. */
  mape: number | null;
  /** Share of rows where the prediction was within 20% of actual. */
  withinBandPct: number | null;
  /** Positive = the model tends to predict below reality. */
  bias: number;
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Predicts one period ahead from a series of prior actuals (oldest first). */
export function predictNextTopup(priorActuals: number[]): number | null {
  const window = priorActuals.slice(-BACKTEST_BASIS);
  if (window.length < BACKTEST_MIN_BASIS) return null;

  const base = mean(window);
  let trend = 0;
  if (window.length >= 4) {
    const half = Math.floor(window.length / 2);
    const older = window.slice(0, window.length - half);
    const recent = window.slice(window.length - half);
    trend = 0.5 * (mean(recent) - mean(older));
  }
  return Math.max(0, Math.round(base + trend));
}

export function buildTopupBacktest(periods: TopupHistoryPeriod[]): TopupBacktestSummary {
  const completed = periods.filter((p) => p.is_past);
  const rows: TopupBacktestRow[] = [];

  for (let i = 0; i < completed.length; i += 1) {
    const priorActuals = completed.slice(0, i).map((p) => Number(p.topups) || 0);
    const predicted = predictNextTopup(priorActuals);
    if (predicted === null) continue;

    const actual = Number(completed[i].topups) || 0;
    const variance = actual - predicted;
    rows.push({
      key: completed[i].key,
      label: completed[i].label,
      basis: Math.min(priorActuals.length, BACKTEST_BASIS),
      predicted,
      actual,
      variance,
      errorPct: actual > 0 ? (Math.abs(variance) / actual) * 100 : null,
    });
  }

  const scored = rows.filter((r) => r.errorPct !== null);
  const predictedTotal = rows.reduce((s, r) => s + r.predicted, 0);
  const actualTotal = rows.reduce((s, r) => s + r.actual, 0);

  return {
    rows,
    predictedTotal,
    actualTotal,
    mape: scored.length ? mean(scored.map((r) => r.errorPct as number)) : null,
    withinBandPct: scored.length
      ? (scored.filter((r) => (r.errorPct as number) <= 20).length / scored.length) * 100
      : null,
    bias: actualTotal - predictedTotal,
  };
}
