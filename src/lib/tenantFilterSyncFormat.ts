/**
 * Single source of truth for formatting the tenant filter "last updated"
 * timestamp across the app. One locale and one set of formatting options
 * are used everywhere — both the inline label and the tooltip — so the
 * displayed value is always identical and timezone-aware.
 */

/** Fixed locale + options used for every tenant-filter timestamp render. */
const TENANT_SYNC_LOCALE: string | undefined = undefined; // undefined = user's runtime locale

const TENANT_SYNC_OPTS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
};

/** Format a tenant-filter sync timestamp, e.g. "Jun 1, 2026, 02:30 PM EAT". */
export function formatTenantSync(date: Date | null): string {
  if (!date) return '';
  return date.toLocaleString(TENANT_SYNC_LOCALE, TENANT_SYNC_OPTS);
}
