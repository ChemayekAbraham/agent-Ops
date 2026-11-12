/**
 * School Fees Plan maths (Welile Schools, agreed 2026-11-11, "option A").
 *
 * - Welile pays the term fee F straight to the school.
 * - The parent repays daily over n days; the plan ends 14 days before the term ends.
 * - A facilitation fee is worked out each day on the term fee still outstanding
 *   at the start of that day, at a daily rate fixed when the plan starts:
 *       rate = 0.66 / (n + 1)
 *   so a parent who pays on schedule pays exactly F × 1.33 in total (33%).
 * - Each payment covers the facilitation fee owed first, then the term fee.
 * - Paying early lowers the balance, so every later day's fee is smaller ("pay early, pay less").
 *
 * User-facing words: "School Fees Plan" and "facilitation fee" (never loan or interest).
 * These helpers are presentation-side estimates only; a live plan's figures come from the server.
 */

/** Days between the plan's end and the end of term (plans are cleared 2 weeks before term ends). */
export const PLAN_ENDS_DAYS_BEFORE_TERM_END = 14;

/** On-schedule total facilitation fee as a share of the term fee. */
export const ON_SCHEDULE_FEE_SHARE = 0.33;

const DAY_MS = 86_400_000;

/** Daily facilitation rate for a plan of `days` days, fixed at sign-up. */
export function dailyRate(days: number): number {
  if (!Number.isFinite(days) || days < 1) return 0;
  return (2 * ON_SCHEDULE_FEE_SHARE) / (Math.floor(days) + 1);
}

/** Plan length in whole days, from `start` to 14 days before `termEnd`. 0 when there is no time left. */
export function planDaysUntil(termEnd: Date, start: Date = new Date()): number {
  const end = Date.UTC(termEnd.getFullYear(), termEnd.getMonth(), termEnd.getDate()) - PLAN_ENDS_DAYS_BEFORE_TERM_END * DAY_MS;
  const from = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  return Math.max(0, Math.floor((end - from) / DAY_MS));
}

export interface ScheduleDay {
  day: number;
  /** Term fee still outstanding at the start of the day. */
  openingBalance: number;
  facilitationFee: number;
  /** Term fee repaid that day. */
  termFeePart: number;
  /** What the parent pays that day on schedule. */
  payment: number;
}

/** The on-schedule plan: an equal slice of the term fee each day, plus that day's facilitation fee. */
export function onScheduleDays(termFee: number, days: number): ScheduleDay[] {
  const n = Math.floor(days);
  if (!(termFee > 0) || n < 1) return [];
  const rate = dailyRate(n);
  const slice = termFee / n;
  return Array.from({ length: n }, (_, i) => {
    const openingBalance = termFee - slice * i;
    const facilitationFee = openingBalance * rate;
    return { day: i + 1, openingBalance, facilitationFee, termFeePart: slice, payment: slice + facilitationFee };
  });
}

export interface PlanSummary {
  days: number;
  rate: number;
  /** First day's payment (the largest; it falls every day). */
  firstDayPayment: number;
  lastDayPayment: number;
  averageDailyPayment: number;
  totalFacilitationFee: number;
  totalOnSchedule: number;
}

export function planSummary(termFee: number, days: number): PlanSummary | null {
  const rows = onScheduleDays(termFee, days);
  if (rows.length === 0) return null;
  const totalFacilitationFee = rows.reduce((s, r) => s + r.facilitationFee, 0);
  return {
    days: rows.length,
    rate: dailyRate(rows.length),
    firstDayPayment: rows[0].payment,
    lastDayPayment: rows[rows.length - 1].payment,
    averageDailyPayment: (termFee + totalFacilitationFee) / rows.length,
    totalFacilitationFee,
    totalOnSchedule: termFee + totalFacilitationFee,
  };
}

/**
 * Clearing the whole plan on `clearOnDay` after paying on schedule until then:
 * total paid = the on-schedule payments for the earlier days + that day's fee + the term fee still outstanding.
 */
export function clearEarly(termFee: number, days: number, clearOnDay: number): { totalPaid: number; saved: number } | null {
  const rows = onScheduleDays(termFee, days);
  const d = Math.floor(clearOnDay);
  if (rows.length === 0 || d < 1 || d > rows.length) return null;
  const before = rows.slice(0, d - 1).reduce((s, r) => s + r.payment, 0);
  const today = rows[d - 1];
  const totalPaid = before + today.openingBalance + today.facilitationFee;
  const fullTotal = rows.reduce((s, r) => s + r.payment, 0);
  return { totalPaid, saved: fullTotal - totalPaid };
}
