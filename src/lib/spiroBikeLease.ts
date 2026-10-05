/**
 * Welile Spiro Bike lease pricing.
 *
 * Flexible 1–24 month terms on a reducing-balance fee:
 *   • the bike price (principal) is split equally across the chosen months,
 *   • each month's fee is 28% of the principal still outstanding at the START
 *     of that month (so it falls every month),
 *   • the daily wallet deduction is that month's due amount divided by the
 *     real number of days in that repayment month, so it also falls every month.
 * Must stay identical to public._spiro_lease_month / _spiro_month_days on the server.
 */
export const SPIRO_BIKE_BASE_PRICE = 120_000;

/** Monthly reducing-balance fee rate applied to the outstanding principal. */
export const SPIRO_MONTHLY_RATE = 0.28;

/** Term bounds offered to agents. */
export const SPIRO_MIN_MONTHS = 1;
export const SPIRO_MAX_MONTHS = 24;

/** Every selectable repayment period. */
export const SPIRO_LEASE_PERIODS = Array.from(
  { length: SPIRO_MAX_MONTHS - SPIRO_MIN_MONTHS + 1 },
  (_, i) => ({ months: SPIRO_MIN_MONTHS + i }),
);

export interface SpiroLeaseMonth {
  /** 1-based month number. */
  month: number;
  /** Principal outstanding at the start of the month. */
  openingPrincipal: number;
  /** Equal principal slice repaid this month. */
  principalDue: number;
  /** 28% of the opening principal. */
  feeDue: number;
  /** principalDue + feeDue. */
  totalDue: number;
  /** Principal outstanding after this month's payment. */
  closingPrincipal: number;
  /** Real calendar days in this month of the lease. */
  days: number;
  /** Daily wallet deduction during this month. */
  daily: number;
}

export interface SpiroLeaseSchedule {
  months: number;
  /** Monthly fee rate as a percentage (28). */
  monthlyRatePct: number;
  /** Bike price. */
  base: number;
  /** Equal principal slice per month. */
  principalPerMonth: number;
  /** Sum of all monthly fees. */
  accessFee: number;
  /** Base price + all fees. */
  total: number;
  /** Fee total as a percentage of the base price. */
  feePct: number;
  /** First month's payment (the highest one). */
  firstMonthly: number;
  /** Last month's payment (the lowest one). */
  lastMonthly: number;
  /** Average monthly payment. */
  monthly: number;
  /** Total days across the whole term. */
  days: number;
  /** First month's daily deduction (the highest one). */
  firstDaily: number;
  /** Last month's daily deduction (the lowest one). */
  lastDaily: number;
  /** Average daily deduction across the term. */
  daily: number;
  /** Month-by-month breakdown. */
  rows: SpiroLeaseMonth[];
}

function clampMonths(months: number): number {
  const n = Math.round(Number(months) || 0);
  if (!Number.isFinite(n)) return SPIRO_MIN_MONTHS;
  return Math.min(SPIRO_MAX_MONTHS, Math.max(SPIRO_MIN_MONTHS, n));
}

function daysBetween(a: Date, b: Date): number {
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / 86_400_000));
}

export function spiroLeaseSchedule(
  months: number,
  basePrice: number = SPIRO_BIKE_BASE_PRICE,
  startDate: Date = new Date(),
): SpiroLeaseSchedule {
  const n = clampMonths(months);
  const base = Math.max(0, Math.round(Number(basePrice) || 0));
  // Exact slice (not rounded up): 100,000 over 12 months -> fees 182,000.
  const principalPerMonth = base / n;

  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);

  const rows: SpiroLeaseMonth[] = [];
  let outstanding = base;
  let cursor = new Date(start);

  for (let m = 1; m <= n; m += 1) {
    const openingPrincipal = outstanding;
    // The last month clears whatever rounding left behind.
    const principalDue = m === n ? openingPrincipal : Math.min(principalPerMonth, openingPrincipal);
    const feeDue = openingPrincipal * SPIRO_MONTHLY_RATE;
    const totalDue = principalDue + feeDue;
    const closingPrincipal = Math.max(0, openingPrincipal - principalDue);

    const next = new Date(start);
    next.setMonth(next.getMonth() + m);
    const days = daysBetween(cursor, next);

    rows.push({
      month: m,
      openingPrincipal,
      principalDue,
      feeDue,
      totalDue,
      closingPrincipal,
      days,
      daily: Math.round(totalDue / days),
    });

    outstanding = closingPrincipal;
    cursor = next;
  }

  const accessFee = Math.round(rows.reduce((s, r) => s + r.feeDue, 0));
  const total = base + accessFee;
  const days = rows.reduce((s, r) => s + r.days, 0);
  const first = rows[0];
  const last = rows[rows.length - 1];

  return {
    months: n,
    monthlyRatePct: Math.round(SPIRO_MONTHLY_RATE * 100),
    base,
    principalPerMonth,
    accessFee,
    total,
    feePct: base > 0 ? Math.round((accessFee / base) * 100) : 0,
    firstMonthly: first.totalDue,
    lastMonthly: last.totalDue,
    monthly: Math.ceil(total / n),
    days,
    firstDaily: first.daily,
    lastDaily: last.daily,
    daily: Math.ceil(total / days),
    rows,
  };
}

/** Full 1–24 month grid for a base price. */
export function spiroLeaseGrid(
  basePrice: number = SPIRO_BIKE_BASE_PRICE,
  startDate: Date = new Date(),
): SpiroLeaseSchedule[] {
  return SPIRO_LEASE_PERIODS.map((p) => spiroLeaseSchedule(p.months, basePrice, startDate));
}

/**
 * Total charge for a term as a percentage of the bike price, under the
 * reducing-balance model: 28% × (n+1)/2 — independent of the price.
 */
export function spiroEffectiveFeePct(months: number): number {
  const n = clampMonths(months);
  return Math.round(SPIRO_MONTHLY_RATE * 100 * ((n + 1) / 2));
}
