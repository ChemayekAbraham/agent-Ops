/**
 * How the desks write numbers. Cards are read on a phone in a hurry: short
 * money, whole days, whole percentages. Tables have room: full money.
 */

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

const isNum = (v: unknown): v is number | string => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/** "152 d", "<1 d", "—". Never decimals on a card. */
export function daysShort(v: number | string | null | undefined): string {
  if (!isNum(v)) return '—';
  const n = Number(v);
  if (n < 1) return '<1 d';
  return `${Math.round(n)} d`;
}

/** "UGX 1.2M" — for cards and tiles. */
export function moneyCard(v: number | string | null | undefined): string {
  if (!isNum(v)) return '—';
  return `UGX ${compact.format(Number(v))}`;
}

/** "UGX 1,234,567" — for tables, sheets and tooltips. */
export function moneyFull(v: number | string | null | undefined): string {
  if (!isNum(v)) return '—';
  return `UGX ${whole.format(Number(v))}`;
}

/** "65%" from a whole percentage (0–100), the way the desk RPCs send them. */
export function pctWhole(v: number | string | null | undefined): string {
  if (!isNum(v)) return '—';
  return `${Math.round(Number(v))}%`;
}

const UGX_FULL = /^UGX\s?([\d,]+(?:\.\d+)?)$/;

/**
 * "UGX 14,350,000" → { short: "UGX 14.4M", full: "UGX 14,350,000" }; anything
 * else comes back unchanged with no `full`.
 */
export function abbreviateMoney(text: string): { short: string; full: string | null } {
  const m = UGX_FULL.exec(text.trim());
  if (!m) return { short: text, full: null };
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 10_000) return { short: text, full: null };
  return { short: moneyCard(n), full: moneyFull(n) };
}
