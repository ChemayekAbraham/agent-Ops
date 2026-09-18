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

/** Tunable settings for the top-up prediction model. */
export interface TopupModelSettings {
  /** Completed periods averaged for the baseline. */
  lookback: number;
  /** Share of the recent-vs-older drift carried forward (0 = ignore trend). */
  trendDamping: number;
  /** Periods required before any trend is applied. */
  minHistory: number;
}

export const DEFAULT_TOPUP_SETTINGS: TopupModelSettings = {
  lookback: BACKTEST_BASIS,
  trendDamping: 0.5,
  minHistory: 4,
};

/** Predicts one period ahead from a series of prior actuals (oldest first). */
export function predictNextTopup(
  priorActuals: number[],
  settings: TopupModelSettings = DEFAULT_TOPUP_SETTINGS,
): number | null {
  const window = priorActuals.slice(-Math.max(2, settings.lookback));
  if (window.length < BACKTEST_MIN_BASIS) return null;

  const base = mean(window);
  let trend = 0;
  if (window.length >= settings.minHistory && settings.trendDamping > 0) {
    const half = Math.floor(window.length / 2);
    const older = window.slice(0, window.length - half);
    const recent = window.slice(window.length - half);
    trend = settings.trendDamping * (mean(recent) - mean(older));
  }
  return Math.max(0, Math.round(base + trend));
}

export function buildTopupBacktest(
  periods: TopupHistoryPeriod[],
  settings: TopupModelSettings = DEFAULT_TOPUP_SETTINGS,
): TopupBacktestSummary {
  const completed = periods.filter((p) => p.is_past);
  const rows: TopupBacktestRow[] = [];

  for (let i = 0; i < completed.length; i += 1) {
    const priorActuals = completed.slice(0, i).map((p) => Number(p.topups) || 0);
    const predicted = predictNextTopup(priorActuals, settings);
    if (predicted === null) continue;

    const actual = Number(completed[i].topups) || 0;
    const variance = actual - predicted;
    rows.push({
      key: completed[i].key,
      label: completed[i].label,
      basis: Math.min(priorActuals.length, Math.max(2, settings.lookback)),
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

/**
 * Typical size of the model's past misses, in UGX. This is the spread the
 * confidence band is built from: how far predictions have actually landed from
 * reality on completed periods (root mean squared error), not a guess.
 */
export function topupResidualSigma(backtest: TopupBacktestSummary): number | null {
  const rows = backtest.rows;
  if (rows.length < BACKTEST_MIN_BASIS) return null;
  const sq = rows.map((r) => r.variance * r.variance);
  return Math.sqrt(mean(sq));
}

/** 80% band ≈ ±1.2816σ under a normal error assumption. */
export const BAND_Z = 1.2816;

export interface TopupBand {
  low: number;
  high: number;
}

/**
 * Band around a predicted top-up value. Uncertainty compounds the further out
 * the period is, so the spread widens with sqrt(steps ahead) — the standard
 * random-walk widening. Never goes below zero: a period cannot receive negative
 * top-ups.
 */
export function topupPredictionBand(
  predicted: number,
  sigma: number | null,
  stepsAhead: number,
): TopupBand | null {
  if (sigma === null || !Number.isFinite(sigma) || sigma <= 0) return null;
  const spread = BAND_Z * sigma * Math.sqrt(Math.max(1, stepsAhead));
  return {
    low: Math.max(0, Math.round(predicted - spread)),
    high: Math.round(predicted + spread),
  };
}

export interface TopupBacktestAccuracy {
  periods: number;
  /** Average signed error (received − predicted): positive means the model runs low. */
  meanError: number | null;
  /** Root-mean-square error across tested periods. */
  rmsError: number | null;
  /** Share of tested periods whose received amount fell inside the 80% band. */
  coverageShare: number | null;
}

/**
 * Accuracy summary over the backtest: average signed error (bias), RMS error,
 * and how often reality landed inside the same 80% band drawn on the chart
 * (sigma from the backtest itself, one period ahead). Coverage is null when
 * there is too little history or zero error variation to form a band.
 */
export function summarizeTopupAccuracy(backtest: TopupBacktestRow[]): TopupBacktestAccuracy {
  const rows = backtest.filter((r) => r.predicted !== null);
  const periods = rows.length;
  if (periods === 0) return { periods: 0, meanError: null, rmsError: null, coverageShare: null };
  const meanError = rows.reduce((s, r) => s + (r.variance ?? 0), 0) / periods;
  const rmsError = Math.sqrt(rows.reduce((s, r) => s + (r.variance ?? 0) ** 2, 0) / periods);
  let coverageShare: number | null = null;
  if (periods >= BACKTEST_MIN_BASIS && rmsError > 0) {
    const inside = rows.filter((r) => {
      const band = topupPredictionBand(r.predicted ?? 0, rmsError, 1);
      return band !== null && r.actual >= band.low && r.actual <= band.high;
    }).length;
    coverageShare = inside / periods;
  }
  return { periods, meanError, rmsError, coverageShare };
}
