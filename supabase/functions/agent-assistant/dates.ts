// Africa/Kampala is UTC+3 with no DST, so a fixed offset is exact.
const KAMPALA_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const PERIODS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "last_7_days",
  "this_month",
  "last_month",
  "last_30_days",
] as const;
export type Period = typeof PERIODS[number];

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Today's date (YYYY-MM-DD) in Africa/Kampala. */
export function kampalaToday(now: number = Date.now()): string {
  return toIso(now + KAMPALA_OFFSET_MS);
}

function addDays(iso: string, days: number): string {
  return toIso(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS);
}

/**
 * Resolve a named period to an inclusive [from, to] date range in Kampala time. Date maths is
 * done here, not by the model: weeks start Monday, ranges never extend past today.
 */
export function resolvePeriod(period: Period, now: number = Date.now()): { from: string; to: string } {
  const today = kampalaToday(now);
  const [y, m] = today.split("-").map(Number);
  // getUTCDay on the Kampala-shifted date: 0=Sun..6=Sat -> days since Monday.
  const sinceMonday = (new Date(Date.parse(`${today}T00:00:00Z`)).getUTCDay() + 6) % 7;
  const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;

  switch (period) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const d = addDays(today, -1);
      return { from: d, to: d };
    }
    case "this_week":
      return { from: addDays(today, -sinceMonday), to: today };
    case "last_week": {
      const start = addDays(today, -sinceMonday - 7);
      return { from: start, to: addDays(start, 6) };
    }
    case "last_7_days":
      return { from: addDays(today, -6), to: today };
    case "this_month":
      return { from: monthStart, to: today };
    case "last_month": {
      const lastOfPrev = addDays(monthStart, -1);
      const [py, pm] = lastOfPrev.split("-").map(Number);
      return { from: `${py}-${String(pm).padStart(2, "0")}-01`, to: lastOfPrev };
    }
    case "last_30_days":
      return { from: addDays(today, -29), to: today };
  }
}
