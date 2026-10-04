/**
 * Kampala (EAT, UTC+3) calendar-day helpers.
 *
 * The CFO receivables/payables reporting RPCs bucket records by Kampala date
 * (`now() AT TIME ZONE 'Africa/Kampala'`), so the UI must label and bucket days
 * the same way whatever timezone the device or browser happens to be in.
 * Reporting layer only — no money, ledger, or balance logic lives here.
 */
const TZ = 'Africa/Kampala';
const DAY = 86_400_000;

/** Calendar day (YYYY-MM-DD) of a value in Kampala time. Plain date strings pass through. */
export function kampalaYmd(value?: string | number | Date | null): string | null {
  if (value == null) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}

/** Today's Kampala calendar day as YYYY-MM-DD. */
export const kampalaTodayYmd = () => kampalaYmd(new Date()) as string;

/** Calendar day `offset` days from Kampala today, as YYYY-MM-DD. */
export function kampalaOffsetYmd(offset: number): string {
  const [y, m, d] = kampalaTodayYmd().split('-').map(Number);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(
    new Date(Date.UTC(y, m - 1, d + offset, 12, 0, 0)),
  );
}

/** Whole days between a calendar day and Kampala today (negative = in the past). */
export function kampalaDayOffset(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  const [ty, tm, td] = kampalaTodayYmd().split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / DAY);
}

/** "Tue, 29 Sept" for a calendar day, always rendered as a Kampala day. */
export function kampalaLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    timeZone: TZ,
  });
}
