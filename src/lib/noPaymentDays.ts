/**
 * "Days without payment" threshold (Tenant Ops Workspaces). Staff choose how many days of silence put a
 * tenant on the list; it was fixed at 20. The number is a parameter of the v2 reports and lives in the URL
 * (`?days=`). The frozen weekly record stays at 20 for ever.
 */

export const NO_PAYMENT_DEFAULT_DAYS = 20;
export const NO_PAYMENT_MIN_DAYS = 1;
export const NO_PAYMENT_MAX_DAYS = 365;
export const NO_PAYMENT_PRESETS = [7, 14, 20, 30, 45, 60] as const;
/** The URL parameter that carries the choice. */
export const NO_PAYMENT_DAYS_PARAM = 'days';

export function isValidNoPaymentDays(n: number): boolean {
  return Number.isInteger(n) && n >= NO_PAYMENT_MIN_DAYS && n <= NO_PAYMENT_MAX_DAYS;
}

/** Reads `?days=`; anything that is not a whole number from 1 to 365 falls back to the default of 20. */
export function parseNoPaymentDays(raw: string | null | undefined): number {
  if (raw == null || !/^\d{1,3}$/.test(raw.trim())) return NO_PAYMENT_DEFAULT_DAYS;
  const n = Number(raw);
  return isValidNoPaymentDays(n) ? n : NO_PAYMENT_DEFAULT_DAYS;
}

/** The three bands the report shows: N+, N+10 and N+20 (20+, 30+ and 40+ at the default). */
export function noPaymentBands(n: number): [number, number, number] {
  return [n, n + 10, n + 20];
}

/** "20+ days" */
export const daysPlus = (n: number) => `${n}+ days`;
/** "20+ Days No Payment" (tab and report titles) */
export const noPaymentTitle = (n: number) => `${n}+ Days No Payment`;
/** "20+ days without payment" (sentences, sheet and file names) */
export const withoutPaymentText = (n: number) => `${n}+ days without payment`;

/** Why a typed value was not accepted, or null when it is fine. */
export function noPaymentDaysError(raw: string): string | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return `Enter a whole number from ${NO_PAYMENT_MIN_DAYS} to ${NO_PAYMENT_MAX_DAYS}`;
  return isValidNoPaymentDays(Number(t)) ? null : `Enter a whole number from ${NO_PAYMENT_MIN_DAYS} to ${NO_PAYMENT_MAX_DAYS}`;
}

/** A file-name friendly form: "30_Plus_Days_No_Payment". */
export const noPaymentFileStem = (n: number) => `${n}_Plus_Days_No_Payment`;
