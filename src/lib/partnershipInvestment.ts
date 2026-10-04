/**
 * Single source of truth for partnership-ops investment limits.
 *
 * Both the inline validation (button-disabled / submit guards) AND the
 * "Allowed range" helper text shown in every partnership ops dialog are
 * derived from the functions below. This guarantees the displayed range and
 * the validation logic can never drift apart.
 */

/** Absolute minimum investment, in UGX. */
export const MIN_INVEST = 1000;

/** Absolute maximum investment, in UGX. */
export const MAX_INVEST = 500_000_000;

export type CurrencyFormatter = (n: number) => string;

/** Deterministic UGX formatter used as the default for helper text. */
export const defaultUGXFormatter: CurrencyFormatter = (n) =>
  `UGX ${Math.round(n).toLocaleString("en-US")}`;

/**
 * Effective maximum allowed, optionally capped by an available balance
 * (e.g. partner wallet balance or agent wallet balance). A nullish / non-finite
 * cap means "no balance cap" → the absolute MAX_INVEST applies. A negative cap
 * clamps to 0.
 */
export function effectiveMaxInvest(balanceCap?: number | null): number {
  if (balanceCap == null || !Number.isFinite(balanceCap)) return MAX_INVEST;
  return Math.min(MAX_INVEST, Math.max(0, balanceCap));
}

/** The inclusive [min, max] bounds for a dialog, given an optional balance cap. */
export function investBounds(balanceCap?: number | null): { min: number; max: number } {
  return { min: MIN_INVEST, max: effectiveMaxInvest(balanceCap) };
}

/** Whether an amount passes validation for the given (optional) balance cap. */
export function isInvestAmountValid(amount: number, balanceCap?: number | null): boolean {
  if (!Number.isFinite(amount)) return false;
  const { min, max } = investBounds(balanceCap);
  return amount >= min && amount <= max;
}

/** Helper text shown under the investment input. */
export function investHelperRange(
  balanceCap?: number | null,
  format: CurrencyFormatter = defaultUGXFormatter,
): string {
  const { min, max } = investBounds(balanceCap);
  return `Allowed range: ${format(min)} – ${format(max)}. Amounts outside this range will disable submission.`;
}
