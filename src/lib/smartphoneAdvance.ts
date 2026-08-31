/**
 * Smartphone advance pricing.
 *
 * The programme charge is internal: Agent Ops sees it as receivables per
 * period, the applicant only ever sees a daily amount and a total repayable.
 */
export const SMARTPHONE_PERIODS = [
  { months: 3, days: 90 },
  { months: 6, days: 180 },
  { months: 9, days: 270 },
  { months: 12, days: 365 },
] as const;

/** Internal only — never shown to the applicant. */
export const SMARTPHONE_INTERNAL_MARKUP: Record<number, number> = { 3: 33, 6: 36, 9: 39, 12: 42 };

export interface SmartphoneScheduleRow {
  months: number;
  days: number;
  /** Internal programme charge percentage. Ops-facing only. */
  markupPct: number;
  total: number;
  daily: number;
}

export function smartphoneSchedule(baseAmount: number, months: number): SmartphoneScheduleRow {
  const period =
    SMARTPHONE_PERIODS.find((p) => p.months === months) ?? SMARTPHONE_PERIODS[SMARTPHONE_PERIODS.length - 1];
  const base = Math.max(0, Math.round(Number(baseAmount) || 0));
  const markupPct = SMARTPHONE_INTERNAL_MARKUP[period.months] ?? 0;
  const total = base > 0 ? Math.round(base + (base * markupPct) / 100) : 0;
  const daily = total > 0 ? Math.ceil(total / period.days) : 0;
  return { months: period.months, days: period.days, markupPct, total, daily };
}

/** Full 3 / 6 / 9 / 12 month grid for a base amount. */
export function smartphoneScheduleGrid(baseAmount: number): SmartphoneScheduleRow[] {
  return SMARTPHONE_PERIODS.map((p) => smartphoneSchedule(baseAmount, p.months));
}
