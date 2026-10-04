/**
 * Funder direct-support earnings projection.
 *
 * A funder who supports a tenant moving into a house earns 15% per month of
 * that house's monthly rent. Daily and weekly figures are derived from the
 * ACTUAL 12-month window that starts on the tenant's move-in date, so leap
 * years and month lengths are respected instead of a flat 365-day divisor.
 */
import { addMonths, differenceInCalendarDays } from 'date-fns';

export const FUNDER_MONTHLY_RATE = 0.15;

export interface FunderEarnings {
  /** Capital required — the house's monthly rent. */
  capital: number;
  monthly: number;
  weekly: number;
  daily: number;
  /** Projected total over the 12 months following the move-in date. */
  annual: number;
  /** Move-in / start date the projection is anchored on. */
  startDate: Date;
  /** End of the 12-month window (start + 12 months). */
  endDate: Date;
  /** Actual number of days in that window (365 or 366). */
  daysInTerm: number;
}

function safe(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Days in the 12-month window that begins on `startDate`. */
export function termDays(startDate: Date): number {
  const end = addMonths(startDate, 12);
  const days = differenceInCalendarDays(end, startDate);
  return days > 0 ? days : 365;
}

export function calcFunderEarnings(monthlyRent: number, startDate: Date = new Date()): FunderEarnings {
  const capital = safe(monthlyRent);
  const monthly = Math.round(capital * FUNDER_MONTHLY_RATE);
  const annual = monthly * 12;
  const days = termDays(startDate);
  return {
    capital,
    monthly,
    weekly: Math.round((annual / days) * 7),
    daily: Math.round(annual / days),
    annual,
    startDate,
    endDate: addMonths(startDate, 12),
    daysInTerm: days,
  };
}

export function sumFunderEarnings(rents: number[], startDate: Date = new Date()): FunderEarnings {
  const totalRent = rents.reduce((a, r) => a + safe(r), 0);
  return calcFunderEarnings(totalRent, startDate);
}
