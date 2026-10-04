/**
 * Pure ROI-cycle date helpers, shared by the payout run and the renewal jobs.
 * (Kept dependency-free so it can be unit-tested outside Deno.)
 */

/** Date-only "today" in the platform timezone (Africa/Kampala). YYYY-MM-DD. */
export function kampalaTodayDateOnly(nowMs?: number): string {
  return new Date(nowMs ?? Date.now()).toLocaleDateString('en-CA', { timeZone: 'Africa/Kampala' });
}

/**
 * Effective next ROI/payout date for a portfolio as a YYYY-MM-DD string.
 *   - When `next_roi_date` is set, that stored date is authoritative.
 *   - When null, derive from created_at + 1 month on `payout_day`, walking
 *     forward month-by-month until the date is today or later.
 */
export function effectiveNextRoiDateOnly(
  nextRoiDate: string | null,
  createdAt: string,
  payoutDay: number | null,
  nowMs?: number,
): string {
  if (nextRoiDate) return String(nextRoiDate).slice(0, 10);

  const created = new Date(createdAt);
  const day = Math.min((payoutDay || created.getUTCDate()) || 15, 28);
  const todayMs = new Date(kampalaTodayDateOnly(nowMs) + 'T00:00:00Z').getTime();
  let d = new Date(Date.UTC(created.getUTCFullYear(), created.getUTCMonth() + 1, day));
  while (d.getTime() < todayMs) {
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, day));
  }
  return d.toISOString().slice(0, 10);
}

/** True iff the portfolio's effective ROI date is today or in the past. */
export function isPortfolioRoiDue(
  p: { next_roi_date: string | null; created_at: string; payout_day: number | null },
  nowMs?: number,
): boolean {
  return effectiveNextRoiDateOnly(p.next_roi_date, p.created_at, p.payout_day, nowMs)
    <= kampalaTodayDateOnly(nowMs);
}

/** Idempotency key used for a portfolio's ROI credit in a given cycle. */
export function roiCycleKey(portfolioId: string, cycleDate: string | null): string {
  return `roi-cycle-${portfolioId}-${(cycleDate || kampalaTodayDateOnly()).slice(0, 10)}`;
}
