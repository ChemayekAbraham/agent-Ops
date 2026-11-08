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
 * Only the monthly Returns rate is mentioned here — no other fees or margins.
 * The rate-aware helpers (`…At`) take the rate the database gives: the public
 * new-partner rate on the public page, the signed-in partner's own rate in the
 * app (design v2 §6.1). The older constants assume a fixed rate and are
 * deprecated.
 */
import { monthlyReturnFor, rateOrNull } from './partnerReturnPolicy';

/**
 * @deprecated A hard-coded 15%. Use the `…At` helpers with the rate from the database.
 * Must have no importer at release (design v2 §6.1, §8.5 #3).
 */
export const EXAMPLE_MONTHLY_RATE = 0.15;

/** Illustrative support amount used in the five steps below. */
export const EXAMPLE_SUPPORT_AMOUNT = 100000;
/** @deprecated Figure at a hard-coded 15%; use supportExampleStepsAt(rate). */
export const EXAMPLE_MONTHLY_RETURN = 15000;
/** @deprecated Figure at a hard-coded 15%; use supportExampleStepsAt(rate). */
export const EXAMPLE_TWELVE_MONTH_TOTAL = 180000;

/** Months a support plan earns for. */
export const EXAMPLE_TERM_MONTHS = 12;

/**
 * @deprecated Figures at a hard-coded 15%; use supportExampleStepsAt(rate).
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

/** @deprecated Monthly Returns at a hard-coded 15%; use exampleMonthlyReturnAt. */
export function exampleMonthlyReturn(fundingAmount: number): number {
  if (!Number.isFinite(fundingAmount) || fundingAmount <= 0) return 0;
  return Math.round(fundingAmount * EXAMPLE_MONTHLY_RATE);
}

/**
 * @deprecated Figure at a hard-coded 15%; use buildSupportPlanExampleLineAt.
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

/** Monthly Returns on `fundingAmount` at `rate` (monthly %, e.g. 10); null when either is unusable. */
export function exampleMonthlyReturnAt(fundingAmount: number, rate: number | null): number | null {
  if (!Number.isFinite(fundingAmount) || fundingAmount <= 0) return null;
  return monthlyReturnFor(fundingAmount, rateOrNull(rate));
}

/**
 * The five steps at `rate`. With no rate (null) the steps state no Returns figure, so a screen
 * never shows a guessed number.
 */
export function supportExampleStepsAt(rate: number | null): string[] {
  const amount = formatFixedUGX(EXAMPLE_SUPPORT_AMOUNT);
  const monthlyValue = exampleMonthlyReturnAt(EXAMPLE_SUPPORT_AMOUNT, rate);
  if (monthlyValue === null) {
    return [
      `You support a tenant with ${amount}.`,
      `The system pays the ${amount} straight to the landlord.`,
      `You earn monthly Returns for ${EXAMPLE_TERM_MONTHS} months at the rate shown in the app.`,
      `The tenant pays back the ${amount} under their Rent Plan.`,
      `After ${EXAMPLE_TERM_MONTHS} months: renew your support, or withdraw your ${amount}.`,
    ];
  }
  const monthly = formatFixedUGX(monthlyValue);
  const total = formatFixedUGX(monthlyValue * EXAMPLE_TERM_MONTHS);
  return [
    `You support a tenant with ${amount}.`,
    `The system pays the ${amount} straight to the landlord.`,
    `You earn ${monthly} every month for ${EXAMPLE_TERM_MONTHS} months (${total} total).`,
    `The tenant pays back the ${amount} plus ${monthly} a month.`,
    `After ${EXAMPLE_TERM_MONTHS} months: renew your support, or withdraw your ${amount}.`,
  ];
}

/**
 * One-line summary of this plan at `rate`: "Support UGX 700,000 → earn UGX 70,000/month for 12
 * months → then renew or withdraw your UGX 700,000". null when there is no usable amount or no
 * rate, so callers hide the line rather than showing "UGX 0" or a guessed figure.
 */
export function buildSupportPlanExampleLineAt(fundingAmount: number, rate: number | null): string | null {
  const monthlyValue = exampleMonthlyReturnAt(fundingAmount, rate);
  if (monthlyValue === null) return null;
  const amount = formatFixedUGX(fundingAmount);
  return `Support ${amount} → earn ${formatFixedUGX(monthlyValue)}/month for ${EXAMPLE_TERM_MONTHS} months → then renew or withdraw your ${amount}`;
}
