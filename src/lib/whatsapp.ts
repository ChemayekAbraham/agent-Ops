/**
 * WhatsApp phone-number utilities.
 *
 * wa.me links require a full international number with a country code and
 * NO leading `+`, `0`, spaces, or punctuation. Applicants enter numbers in
 * many formats (`07XX...`, `+256 7XX...`, `256-7XX...`, `00256...`), so we
 * normalize everything to bare international digits and validate the result
 * before building a link or storing it.
 */

const UG_COUNTRY_CODE = '256';

/**
 * Normalize any user-entered phone number to bare international digits.
 * - strips all non-digits (spaces, `+`, `-`, `()`)
 * - `00<cc>...` international prefix -> `<cc>...`
 * - local Ugandan `0XXXXXXXXX` (10 digits) -> `2567XXXXXXXX`
 * - a bare 9-digit local number (`7XXXXXXXX`) -> `2567XXXXXXXX`
 * Returns bare digits (no `+`).
 */
export function normalizeWa(num: string): string {
  let d = (num || '').replace(/[^\d]/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2); // 00256... -> 256...
  if (d.startsWith('0')) {
    // Local format: drop the trunk 0 and prepend the UG country code.
    d = `${UG_COUNTRY_CODE}${d.slice(1)}`;
  } else if (d.length === 9 && d.startsWith('7')) {
    // Bare local mobile without the leading 0.
    d = `${UG_COUNTRY_CODE}${d}`;
  }
  return d;
}

/**
 * A normalized WhatsApp number is valid when it has a country code plus a
 * subscriber number — realistically 10 to 15 digits (E.164 caps at 15).
 */
export function isValidWaNumber(num: string): boolean {
  const d = normalizeWa(num);
  return /^\d{10,15}$/.test(d);
}

/** Format a stored number for display, e.g. `+256782123456`. */
export function formatWaDisplay(num: string): string {
  const d = normalizeWa(num);
  return d ? `+${d}` : (num || '');
}

const DEFAULT_HIRING_MESSAGE =
  'Hello, this is the Welile hiring team reaching out about your job application. Do you have a moment to chat?';

/** Build a wa.me click-to-chat link with an optional prefilled message. */
export function waLink(num: string, message: string = DEFAULT_HIRING_MESSAGE): string {
  const digits = normalizeWa(num);
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
