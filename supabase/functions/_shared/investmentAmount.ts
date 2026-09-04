/**
 * SINGLE SOURCE OF TRUTH for the minimum partnership-ops investment amount.
 *
 * The frontend mirror lives in `src/lib/partnershipInvestment.ts`
 * (MIN_INVEST = 1000). Every investment edge function — coo-create-portfolio,
 * coo-invest-for-partner, agent-invest-for-partner, create-investor-portfolio —
 * MUST gate on this exact rule so the UI, validation, and backend stay in sync.
 *
 * Boundary contract (verified in investmentAmount_test.ts):
 *   - amount === 1000  -> VALID   (portfolio creation / invest-for-partner succeeds)
 *   - amount  <  1000  -> INVALID (rejected with MIN_INVESTMENT_ERROR / 400)
 */
export const MIN_INVESTMENT_UGX = 1000;

export const MIN_INVESTMENT_ERROR = "Minimum investment is UGX 1,000";
export const MIN_INVESTMENT_ERROR_PORTFOLIO = "Investment amount must be at least UGX 1,000";

/**
 * Returns true when `amount` is an acceptable investment (>= UGX 1,000).
 * Rejects null/undefined/NaN/0 and any value strictly below the minimum.
 */
export function isValidInvestmentAmount(amount: unknown): amount is number {
  return typeof amount === "number" && Number.isFinite(amount) && (amount as number) >= MIN_INVESTMENT_UGX;
}
