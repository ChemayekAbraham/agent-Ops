import { differenceInCalendarDays, addMonths } from 'date-fns';
import { extractDateOnly, dateOnlyToLocalDate } from '@/lib/portfolioDates';

export type PortfolioState = 'active' | 'pending' | 'matured' | 'paused' | 'locked' | 'withdrawn';

export function normalizePortfolioState(status: string | null | undefined): PortfolioState {
  switch ((status || '').toLowerCase()) {
    case 'active': return 'active';
    case 'pending':
    case 'pending_approval': return 'pending';
    case 'matured': return 'matured';
    case 'locked': return 'locked';
    case 'paused':
    case 'suspended': return 'paused';
    case 'withdrawn': return 'withdrawn';
    default: return 'pending';
  }
}

export interface AccrualInput {
  investment_amount: number | string;
  roi_percentage: number | string;
  status: string | null;
  next_roi_date: string | null;
  created_at: string | null;
  maturity_date: string | null;
}

export interface AccrualResult {
  state: PortfolioState;
  /** Server-authoritative principal */
  deployed: number;
  monthlyRoiPct: number;
  /** deployed * monthlyROI/100 */
  expectedMonthlyReturn: number;
  /** Length of the current payout cycle in days (derived from real dates when possible) */
  cycleDays: number;
  /** Indicative daily accrual — expectedMonthlyReturn / cycleDays */
  dailyAccrual: number;
  /** Days elapsed inside the current cycle */
  cycleElapsedDays: number;
  /** Accrued so far in the current payout cycle (indicative) */
  cycleAccrued: number;
  /** 0..1 progress through the current cycle */
  cycleProgress: number;
  daysToPayout: number | null;
  nextPayoutDate: Date | null;
  /** True when the cycle maps to a calendar month, so "This month" wording is safe */
  isMonthlyCycle: boolean;
}

function toDate(value: string | null | undefined): Date | null {
  const dateOnly = extractDateOnly(value);
  return dateOnly ? dateOnlyToLocalDate(dateOnly) : null;
}

export function computeAccrual(p: AccrualInput): AccrualResult {
  const state = normalizePortfolioState(p.status);
  const deployed = Number(p.investment_amount) || 0;
  const monthlyRoiPct = Number(p.roi_percentage) || 0;
  const expectedMonthlyReturn = (deployed * monthlyRoiPct) / 100;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const nextPayoutDate = toDate(p.next_roi_date);
  const startDate = toDate(p.created_at);

  // Cycle start = one month before the next payout (real payout cadence),
  // clamped to the portfolio start date for the very first cycle.
  let cycleStart: Date | null = nextPayoutDate ? addMonths(nextPayoutDate, -1) : null;
  if (cycleStart && startDate && startDate > cycleStart) cycleStart = startDate;
  // Guard against bad/forward-dated records where the start lands after the
  // payout date — the cycle then has no meaningful span.
  if (cycleStart && nextPayoutDate && cycleStart > nextPayoutDate) cycleStart = nextPayoutDate;

  let cycleDays = 30;
  if (cycleStart && nextPayoutDate) {
    const span = differenceInCalendarDays(nextPayoutDate, cycleStart);
    if (span > 0) cycleDays = span;
  }

  const isActive = state === 'active';
  const dailyAccrual = isActive && cycleDays > 0 ? expectedMonthlyReturn / cycleDays : 0;
  const daysToPayoutRaw = nextPayoutDate ? differenceInCalendarDays(nextPayoutDate, today) : null;

  let cycleElapsedDays = 0;
  if (isActive && daysToPayoutRaw !== null && daysToPayoutRaw <= 0) {
    // Payout date reached or passed: the cycle has fully earned out.
    cycleElapsedDays = cycleDays;
  } else if (isActive && cycleStart) {
    cycleElapsedDays = Math.max(0, Math.min(cycleDays, differenceInCalendarDays(today, cycleStart)));
  }

  const cycleAccrued = isActive ? dailyAccrual * cycleElapsedDays : 0;
  const cycleProgress = cycleDays > 0 ? Math.max(0, Math.min(1, cycleElapsedDays / cycleDays)) : 0;
  const daysToPayout = daysToPayoutRaw;

  return {
    state,
    deployed,
    monthlyRoiPct,
    expectedMonthlyReturn,
    cycleDays,
    dailyAccrual,
    cycleElapsedDays,
    cycleAccrued,
    cycleProgress,
    daysToPayout,
    nextPayoutDate,
    isMonthlyCycle: cycleDays >= 28 && cycleDays <= 31,
  };
}

export function summarizeAccruals(items: AccrualResult[]) {
  const active = items.filter(i => i.state === 'active');
  return {
    activeCount: active.length,
    totalDeployed: active.reduce((s, i) => s + i.deployed, 0),
    accruedToday: active.reduce((s, i) => s + i.dailyAccrual, 0),
    cycleAccrued: active.reduce((s, i) => s + i.cycleAccrued, 0),
    expectedMonthlyReturn: active.reduce((s, i) => s + i.expectedMonthlyReturn, 0),
    allMonthly: active.length > 0 && active.every(i => i.isMonthlyCycle),
  };
}
