/**
 * Partner Return cycles (migration 20261024140000_return_cycle_guard).
 *
 * A portfolio receives one Return per cycle, and a cycle is the CALENDAR MONTH of its scheduled Return date — not
 * the exact date, which staff can edit. The database enforces this; these helpers only let screens name the cycle
 * a request is for and recognise a cycle that is already reserved.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function localDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** The scheduled Return date a payout, compound or split request is for (YYYY-MM-DD). */
export function returnCycleAnchor(
  p: { nextRoiDate?: string | null; nextPayoutDate?: string | null },
  today: Date = new Date(),
): string {
  for (const candidate of [p.nextRoiDate, p.nextPayoutDate]) {
    const v = (candidate || '').slice(0, 10);
    if (DATE_ONLY.test(v)) return v;
  }
  return localDateOnly(today);
}

/** The cycle a scheduled Return date belongs to: the first day of its month (YYYY-MM-01). */
export function returnCycleMonth(anchor: string): string {
  if (!DATE_ONLY.test(anchor.slice(0, 10))) throw new Error(`Not a date: ${anchor}`);
  return `${anchor.slice(0, 7)}-01`;
}

/** Ledger key the database gives a Return posted under a cycle reservation. */
export const RETURN_CYCLE_KEY_PREFIX = 'return-cycle:';
