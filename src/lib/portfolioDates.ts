import { format, isValid, parse } from 'date-fns';

const pad2 = (value: number) => String(value).padStart(2, '0');

export function formatLocalDateOnly(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatUtcDateOnly(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export function dateOnlyToLocalDate(dateOnly: string): Date {
  const [year, month, day] = dateOnly.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function dateOnlyToUtcMiddayIso(dateOnly: string): string {
  return `${dateOnly}T12:00:00.000Z`;
}

export function extractDateOnly(value: string | null | undefined): string | null {
  if (!value) return null;

  const trimmed = String(value).trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;

  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : formatLocalDateOnly(date);
}

export function formatDateOnlyForDisplay(
  value: string | null | undefined,
  options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' },
): string {
  const dateOnly = extractDateOnly(value);
  if (!dateOnly) return '—';

  return dateOnlyToLocalDate(dateOnly).toLocaleDateString('en-UG', options);
}

export function parseContributionDate(raw: any): string | null {
  if (raw == null || raw === '') return null;

  if (typeof raw === 'number') {
    const serial = Math.floor(raw);
    const excelDays = serial > 59 ? serial - 1 : serial;
    const date = new Date(Date.UTC(1899, 11, 31 + excelDays));
    return Number.isNaN(date.getTime()) ? null : formatUtcDateOnly(date);
  }

  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return formatUtcDateOnly(raw);
  }

  const value = String(raw).trim();
  if (!value) return null;

  if (/^\d{1,2}-[A-Za-z]{3}-\d{2}$/.test(value)) {
    const date = parse(value, 'd-MMM-yy', new Date());
    return isValid(date) ? format(date, 'yyyy-MM-dd') : null;
  }

  if (/^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(value)) {
    const date = parse(value, 'd-MMM-yyyy', new Date());
    return isValid(date) ? format(date, 'yyyy-MM-dd') : null;
  }

  const isoMatch = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (isoMatch) {
    return `${isoMatch[1]}-${pad2(Number(isoMatch[2]))}-${pad2(Number(isoMatch[3]))}`;
  }

  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value)) {
    const date = parse(value, 'M/d/yyyy', new Date());
    return isValid(date) ? format(date, 'yyyy-MM-dd') : null;
  }

  if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(value)) {
    const date = parse(value, 'd-M-yyyy', new Date());
    return isValid(date) ? format(date, 'yyyy-MM-dd') : null;
  }

  return null;
}

/**
 * When a portfolio's `payout_day` is edited, its already-scheduled
 * `next_roi_date` must move too — otherwise the two fields drift. The ROI
 * payout engine (see supabase/functions/process-supporter-roi/roiDateGate.ts)
 * treats `next_roi_date` as authoritative whenever it's set and ignores
 * `payout_day` entirely in that case, so a payout-day-only edit silently has
 * no effect on when the partner actually gets paid.
 *
 * Keeps the same scheduled cycle/month (derived from the existing
 * next_roi_date, or created_at + 1 month if none is set yet) and just moves
 * it to the new day-of-month. Rolls forward to the next month if that would
 * land in the past relative to `now`.
 */
export function recomputeNextRoiDateForPayoutDay(
  currentNextRoiDate: string | null | undefined,
  createdAt: string | null | undefined,
  newPayoutDay: number,
  now: Date = new Date(),
): string {
  const day = Math.min(Math.max(Math.round(newPayoutDay) || 1, 1), 28);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const currentDateOnly = extractDateOnly(currentNextRoiDate);
  let base: Date;
  if (currentDateOnly) {
    const d = dateOnlyToLocalDate(currentDateOnly);
    base = new Date(d.getFullYear(), d.getMonth(), 1);
  } else {
    const createdDateOnly = extractDateOnly(createdAt);
    const created = createdDateOnly ? dateOnlyToLocalDate(createdDateOnly) : new Date(createdAt || now);
    base = new Date(created.getFullYear(), created.getMonth() + 1, 1);
  }

  let next = new Date(base.getFullYear(), base.getMonth(), day);
  while (next.getTime() < today.getTime()) {
    next = new Date(next.getFullYear(), next.getMonth() + 1, day);
  }
  return formatLocalDateOnly(next);
}

/**
 * Build the forward-projection compound history rows for the
 * partner-portfolio-compounded email. The current month (the cycle that
 * was just compounded) is intentionally excluded — its result is the
 * "New Total Partnership Value" headline. The breakdown starts from the
 * month after the compound month and projects monthly through the
 * portfolio's maturity (contributionDate + durationMonths).
 *
 * Anchoring to contributionDate (not cycle/payment count) prevents drift
 * if any past cycle was skipped, backfilled, or processed manually.
 */
export interface CompoundProjectionRow {
  cycle: number;
  month_name: string;
  date: string;
  balance_before: number;
  return_amount: number;
  balance_after: number;
}

export function buildCompoundProjection(params: {
  contributionDate: string | Date;
  durationMonths: number;
  newPrincipal: number;
  roiPct: number;
  compoundDate?: Date;
}): CompoundProjectionRow[] {
  const { durationMonths, newPrincipal, roiPct } = params;
  const compoundDate = params.compoundDate ?? new Date();
  const contribution =
    params.contributionDate instanceof Date
      ? params.contributionDate
      : new Date(params.contributionDate);

  if (!Number.isFinite(durationMonths) || durationMonths <= 0) return [];
  if (!Number.isFinite(newPrincipal) || newPrincipal <= 0) return [];
  if (Number.isNaN(contribution.getTime())) return [];

  // First day of the month AFTER the compound month.
  const projectionStart = new Date(
    compoundDate.getFullYear(),
    compoundDate.getMonth() + 1,
    1,
  );

  // Maturity = contribution date + duration_months (same day of month).
  const maturity = new Date(contribution);
  maturity.setMonth(maturity.getMonth() + durationMonths);

  // Inclusive whole-month count between projectionStart and maturity.
  const monthsBetween = (a: Date, b: Date) =>
    (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  const remainingMonths = Math.max(0, monthsBetween(projectionStart, maturity));

  // Cycle index of the FIRST projected row = months elapsed since
  // contribution + 1. (projectionStart is exclusive of the compounded month.)
  const monthsElapsed = Math.max(0, monthsBetween(contribution, projectionStart));

  const rows: CompoundProjectionRow[] = [];
  let runningPrincipal = newPrincipal;
  for (let i = 0; i < remainingMonths; i++) {
    const d = new Date(projectionStart);
    d.setMonth(d.getMonth() + i);
    const earned = Math.round((runningPrincipal * roiPct) / 100);
    const after = runningPrincipal + earned;
    rows.push({
      cycle: monthsElapsed + i + 1,
      month_name: d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
      date: d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
      balance_before: runningPrincipal,
      return_amount: earned,
      balance_after: after,
    });
    runningPrincipal = after;
  }
  return rows;
}