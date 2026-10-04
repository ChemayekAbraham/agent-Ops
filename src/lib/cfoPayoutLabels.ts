/**
 * Global, single-source-of-truth labels for CFO wallet payout operations.
 *
 * Every CFO payout UI element — toggle buttons, action button, tooltips,
 * toasts, and audit/action logs — MUST use these constants so the wording
 * stays consistent across the entire app.
 *
 * - `credit`  → money moving INTO a user's wallet  → "Send money to users wallet"
 * - `debit`   → money moving OUT of a user's wallet → "Money from users wallets"
 */

export const CFO_PAYOUT_LABELS = {
  /** Money sent INTO a user's wallet. */
  credit: 'Send money to users wallet',
  /** Money taken OUT of a user's wallet. */
  debit: 'Money from users wallets',
} as const;

export type CfoPayoutDirection = keyof typeof CFO_PAYOUT_LABELS;

/** Returns the canonical label for a credit/debit payout direction. */
export function cfoPayoutLabel(direction: CfoPayoutDirection): string {
  return CFO_PAYOUT_LABELS[direction];
}

/** Verb-style phrasing for sentences, e.g. "Send money to {name}'s wallet". */
export const CFO_PAYOUT_VERB = {
  credit: 'Send money to',
  debit: 'Take money from',
} as const;

/** Success-toast titles for completed payout operations. */
export const CFO_PAYOUT_TOAST = {
  credit: "✅ Money sent to user's wallet",
  debit: "✅ Money taken from user's wallet",
} as const;
