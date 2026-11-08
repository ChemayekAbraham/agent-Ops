/**
 * Funder direct-support earnings projection.
 *
 * A funder who supports a tenant moving into a house earns a monthly Returns
 * rate on that house's monthly rent (calcFunderEarningsAt takes the rate the
 * database gives; the deprecated helpers below still assume the old fixed
 * rate). Daily and weekly figures are derived from the
 * ACTUAL 12-month window that starts on the tenant's move-in date, so leap
 * years and month lengths are respected instead of a flat 365-day divisor.
 */
import { addMonths, differenceInCalendarDays } from 'date-fns';
import { monthlyReturnFor, rateOrNull } from './partnerReturnPolicy';

/**
 * @deprecated A hard-coded 15%. Use calcFunderEarningsAt / sumFunderEarningsAt with the right rate:
 * the signed-in partner's own rate (useOwnNewPortfolioRate) on their screens, the public
 * new-partner rate (usePartnerReturnPolicy) on logged-out, share and agent screens. Must have no
 * importer at release (design v2 §6.1, §8.5 #3).
 */
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

/** @deprecated Prices at a hard-coded 15%; use calcFunderEarningsAt (see FUNDER_MONTHLY_RATE). */
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

/** @deprecated Prices at a hard-coded 15%; use sumFunderEarningsAt (see FUNDER_MONTHLY_RATE). */
export function sumFunderEarnings(rents: number[], startDate: Date = new Date()): FunderEarnings {
  const totalRent = rents.reduce((a, r) => a + safe(r), 0);
  return calcFunderEarnings(totalRent, startDate);
}

/** FunderEarnings at a given rate: every Returns figure is null when the rate is unknown. */
export interface FunderEarningsAt {
  capital: number;
  /** The monthly rate used (%, e.g. 10), or null when unknown. */
  rate: number | null;
  monthly: number | null;
  weekly: number | null;
  daily: number | null;
  annual: number | null;
  startDate: Date;
  endDate: Date;
  daysInTerm: number;
}

/**
 * Earnings on supporting a house at `rate` (monthly %, e.g. 10). The rate comes from the database:
 * the signed-in partner's own rate (useOwnNewPortfolioRate) or the public new-partner rate
 * (usePartnerReturnPolicy). null -> null figures (show no number). Never a default.
 */
export function calcFunderEarningsAt(monthlyRent: number, startDate: Date = new Date(), rate: number | null): FunderEarningsAt {
  const capital = safe(monthlyRent);
  const r = rateOrNull(rate);
  const monthly = monthlyReturnFor(capital, r);
  const annual = monthly === null ? null : monthly * 12;
  const days = termDays(startDate);
  return {
    capital,
    rate: r,
    monthly,
    weekly: annual === null ? null : Math.round((annual / days) * 7),
    daily: annual === null ? null : Math.round(annual / days),
    annual,
    startDate,
    endDate: addMonths(startDate, 12),
    daysInTerm: days,
  };
}

export function sumFunderEarningsAt(rents: number[], startDate: Date = new Date(), rate: number | null): FunderEarningsAt {
  const totalRent = rents.reduce((a, r) => a + safe(r), 0);
  return calcFunderEarningsAt(totalRent, startDate, rate);
}
