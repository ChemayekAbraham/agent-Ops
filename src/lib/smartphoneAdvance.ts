/**
 * Smartphone advance pricing — reducing balance.
 *
 * Monthly principal = device amount / months (equal, remainder on the last month).
 * Monthly charge    = 28% of the OPENING outstanding principal for that month.
 * Monthly due       = monthly principal + monthly charge.
 * Daily deduction   = that month's due / number of days in that repayment month.
 *
 * Because the charge follows the shrinking principal, the monthly due and the
 * daily deduction both fall over the life of the plan.
 *
 * The 28% rate is internal: Agent Ops sees it, the applicant only ever sees the
 * daily amounts, the monthly schedule and the total repayable.
 */
export const SMARTPHONE_PERIODS = [
  { months: 3, days: 90 },
  { months: 6, days: 180 },
  { months: 9, days: 270 },
  { months: 12, days: 365 },
] as const;

/** Internal only — never shown to the applicant. */
export const SMARTPHONE_MONTHLY_CHARGE_PCT = 28;

export interface SmartphoneMonthRow {
  /** 1-based month number in the plan. */
  monthIndex: number;
  /** yyyy-mm-dd */
  periodStart: string;
  /** yyyy-mm-dd */
  periodEnd: string;
  daysInPeriod: number;
  openingPrincipal: number;
  principalDue: number;
  chargeDue: number;
  totalDue: number;
  dailyDeduction: number;
}

export interface SmartphoneReducingSchedule {
  amount: number;
  months: number;
  /** Total days covered by the schedule. */
  days: number;
  totalCharge: number;
  totalRepayable: number;
  /** First month's daily deduction — the headline figure. */
  firstDaily: number;
  /** Last month's daily deduction — the lowest figure. */
  lastDaily: number;
  rows: SmartphoneMonthRow[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

function addMonths(start: Date, n: number): Date {
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return target;
}

function parseStart(startDate?: string | Date): Date {
  if (startDate instanceof Date) return new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
  if (typeof startDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(startDate)) {
    const [y, m, d] = startDate.slice(0, 10).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function normalisedMonths(months: number): number {
  const found = SMARTPHONE_PERIODS.find((p) => p.months === months);
  return found ? found.months : SMARTPHONE_PERIODS[SMARTPHONE_PERIODS.length - 1].months;
}

/** Full reducing-balance schedule for a device amount over a chosen period. */
export function smartphoneReducingSchedule(
  baseAmount: number,
  months: number,
  startDate?: string | Date,
): SmartphoneReducingSchedule {
  const amount = Math.max(0, Math.round(Number(baseAmount) || 0));
  const n = normalisedMonths(months);
  const start = parseStart(startDate);

  const rows: SmartphoneMonthRow[] = [];
  if (amount <= 0) {
    return { amount: 0, months: n, days: 0, totalCharge: 0, totalRepayable: 0, firstDaily: 0, lastDaily: 0, rows };
  }

  const perMonth = Math.floor(amount / n);
  let opening = amount;
  let totalCharge = 0;
  let totalRepayable = 0;
  let days = 0;

  for (let m = 1; m <= n; m += 1) {
    const periodStart = addMonths(start, m - 1);
    const nextStart = addMonths(start, m);
    const periodEnd = new Date(nextStart.getTime() - 24 * 60 * 60 * 1000);
    const daysInPeriod = Math.max(
      1,
      Math.round((nextStart.getTime() - periodStart.getTime()) / (24 * 60 * 60 * 1000)),
    );

    const principalDue = m === n ? opening : perMonth;
    const chargeDue = Math.round((opening * SMARTPHONE_MONTHLY_CHARGE_PCT) / 100);
    const totalDue = principalDue + chargeDue;
    const dailyDeduction = Math.ceil(totalDue / daysInPeriod);

    rows.push({
      monthIndex: m,
      periodStart: iso(periodStart),
      periodEnd: iso(periodEnd),
      daysInPeriod,
      openingPrincipal: opening,
      principalDue,
      chargeDue,
      totalDue,
      dailyDeduction,
    });

    totalCharge += chargeDue;
    totalRepayable += totalDue;
    days += daysInPeriod;
    opening -= principalDue;
  }

  return {
    amount,
    months: n,
    days,
    totalCharge,
    totalRepayable,
    firstDaily: rows[0]?.dailyDeduction ?? 0,
    lastDaily: rows[rows.length - 1]?.dailyDeduction ?? 0,
    rows,
  };
}

export interface SmartphoneScheduleRow {
  months: number;
  days: number;
  /** Effective total programme charge as a percentage of the device amount. Ops-facing only. */
  markupPct: number;
  total: number;
  /** First month's daily deduction — it reduces every month after that. */
  daily: number;
  /** Last month's daily deduction. */
  dailyLast: number;
  schedule: SmartphoneReducingSchedule;
}

/** Headline figures for one period: first-month daily + total repayable. */
export function smartphoneSchedule(
  baseAmount: number,
  months: number,
  startDate?: string | Date,
): SmartphoneScheduleRow {
  const s = smartphoneReducingSchedule(baseAmount, months, startDate);
  return {
    months: s.months,
    days: s.days,
    markupPct: s.amount > 0 ? Math.round((s.totalCharge / s.amount) * 100) : 0,
    total: s.totalRepayable,
    daily: s.firstDaily,
    dailyLast: s.lastDaily,
    schedule: s,
  };
}

/** Full 3 / 6 / 9 / 12 month grid for a device amount. */
export function smartphoneScheduleGrid(baseAmount: number, startDate?: string | Date): SmartphoneScheduleRow[] {
  return SMARTPHONE_PERIODS.map((p) => smartphoneSchedule(baseAmount, p.months, startDate));
}
