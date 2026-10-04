/**
 * Single authoritative definition of "available to withdraw" on the client.
 *
 * The wallet UI and the withdrawal flow BOTH derive their figure from
 * `get_user_wallet_view` (strict, ledger-backed, holds already netted).
 * These helpers exist so the arithmetic is testable and identical in both
 * places, and so an UNKNOWN balance (failed read) can never be rendered as
 * a zero balance.
 */

export interface StrictWalletBuckets {
  /** Withdrawable bucket from the strict wallet view. */
  withdrawable: number;
  /** Operational float — company money. NEVER withdrawable. */
  floatBalance?: number;
  /** Advance/liability bucket. NEVER withdrawable. */
  advanceBalance?: number;
  /** In-flight withdrawal holds. Subtracted if not already netted. */
  pendingHolds?: number;
  /** True when `withdrawable` already has holds subtracted (RPC does). */
  holdsAlreadyNetted?: boolean;
}

/**
 * Authoritative available-to-withdraw amount.
 * Float and advance buckets are excluded by construction.
 */
export function computeWithdrawableAvailable(b: StrictWalletBuckets): number {
  const holds = b.holdsAlreadyNetted ? 0 : Math.max(0, Number(b.pendingHolds ?? 0));
  return Math.max(0, Number(b.withdrawable ?? 0) - holds);
}

/**
 * Cap used by the withdraw flow.
 *
 * - `ledgerAvailable === null` means UNKNOWN (read failed / not yet fetched):
 *   fall back to the figure the wallet UI is already showing, and let the
 *   server-side `submit_withdrawal_request` gate be the final authority.
 *   It must NOT collapse to 0.
 * - When known, take the lesser of the two so a drifted cache can never
 *   inflate the cap.
 */
export function resolveWithdrawCap(opts: {
  uiAvailable: number;
  ledgerAvailable: number | null;
  trustUiAvailable?: boolean;
}): number {
  const ui = Math.max(0, Number(opts.uiAvailable ?? 0));
  if (opts.trustUiAvailable) return ui;
  if (opts.ledgerAvailable === null || !Number.isFinite(opts.ledgerAvailable)) return ui;
  return Math.max(0, Math.min(ui, Number(opts.ledgerAvailable)));
}
