/**
 * Worked example shown on both support-plan surfaces: the public
 * /support/:planId page and the in-app Support Plan sheet.
 *
 * Amounts in this file are written with the ISO 4217 code and deliberately do
 * NOT go through the currency-switching formatter. This is approved sales copy
 * whose wording is fixed, so it has to read the same for a signed-out visitor
 * on a shared WhatsApp link as for a signed-in Supporter who has changed their
 * display currency.
 *
 * Only the 15% monthly return is mentioned here — no other fees or margins.
 */

/** Monthly return rate the copy is written against. */
export const EXAMPLE_MONTHLY_RATE = 0.15;

/** Illustrative figures used in the five steps below. */
export const EXAMPLE_SUPPORT_AMOUNT = 100000;
export const EXAMPLE_MONTHLY_RETURN = 15000;
export const EXAMPLE_TWELVE_MONTH_TOTAL = 180000;

/**
 * The five steps, in order. Kept as plain strings so the same wording renders
 * on both surfaces and can be checked against the approved copy.
 */
export const SUPPORT_EXAMPLE_STEPS = [
  'You support a tenant with UGX 100,000.',
  'The system pays the UGX 100,000 straight to the landlord.',
  'You earn UGX 15,000 every month for 12 months (UGX 180,000 total).',
  'The tenant pays back the UGX 100,000 plus UGX 15,000 a month.',
  'After 12 months: renew your support, or withdraw your UGX 100,000.',
] as const;

/** Operational guarantee line — must stay visible on both surfaces. */
export const OPERATIONAL_GUARANTEE_LINE =
  "Welile provides an operational guarantee for every tenant you support.";

/** UGX amount with thousands separators, e.g. "UGX 100,000". */
export function formatFixedUGX(amount: number): string {
  const safe = Number.isFinite(amount) ? Math.round(amount) : 0;
  return `UGX ${safe.toLocaleString('en-US')}`;
}

/** Monthly return at the 15% rate, rounded to whole UGX. */
export function exampleMonthlyReturn(fundingAmount: number): number {
  if (!Number.isFinite(fundingAmount) || fundingAmount <= 0) return 0;
  return Math.round(fundingAmount * EXAMPLE_MONTHLY_RATE);
}

/**
 * One-line summary of this exact plan, derived from its funding amount:
 * "Support UGX 700,000 → earn UGX 105,000/month for 12 months → then renew or
 * withdraw your UGX 700,000".
 *
 * Returns null when there is no usable amount, so callers hide the line rather
 * than showing "UGX 0".
 */
export function buildSupportPlanExampleLine(fundingAmount: number): string | null {
  if (!Number.isFinite(fundingAmount) || fundingAmount <= 0) return null;
  const amount = formatFixedUGX(fundingAmount);
  const monthly = formatFixedUGX(exampleMonthlyReturn(fundingAmount));
  return `Support ${amount} → earn ${monthly}/month for 12 months → then renew or withdraw your ${amount}`;
}
