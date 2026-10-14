/**
 * Custodial (wallet-scope) transfers in the cash-flow statement.
 *
 * A `wallet_transfer` between two users posts a cash_out leg for the sender
 * and a cash_in leg for the receiver, both in wallet scope. Total custody is
 * unchanged, so the statement must use the NET of the two legs. Counting only
 * the cash_out leg (the earlier behaviour) understated custodial cash by the
 * whole transfer volume.
 *
 * Positive: net outflow from user wallets. Negative: net inflow (for example a
 * platform-funded transfer into wallets).
 */
export function netWalletTransferOutflow(walletOut: number, walletIn: number): number {
  return Number(walletOut || 0) - Number(walletIn || 0);
}
