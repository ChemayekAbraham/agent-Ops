/**
 * Daytime-only house listing window (EAT / Africa/Kampala).
 * Agents & sub-agents may only create house listings between these hours;
 * the same rule is enforced server-side by `enforce_daytime_house_listing`.
 */
export const LISTING_OPEN_HOUR_EAT = 6;   // 6:00 AM inclusive
export const LISTING_CLOSE_HOUR_EAT = 18; // 6:00 PM exclusive

/** Current hour (0-23) in Africa/Kampala regardless of user's device tz. */
export function getEatHour(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Kampala',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const h = parts.find((p) => p.type === 'hour')?.value ?? '0';
  // '24' can appear in some ICU builds when clock is at midnight — normalise.
  const n = parseInt(h, 10);
  return n === 24 ? 0 : n;
}

export function isListingDaytime(now: Date = new Date()): boolean {
  const h = getEatHour(now);
  return h >= LISTING_OPEN_HOUR_EAT && h < LISTING_CLOSE_HOUR_EAT;
}

export const LISTING_HOURS_LABEL = '6:00 AM – 6:00 PM (EAT)';

export const LISTING_NIGHT_MESSAGE =
  `House listing is only allowed between ${LISTING_HOURS_LABEL}. ` +
  `Please list this house during the day so photos and the location can be captured clearly.`;