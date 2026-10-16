/**
 * Partner wallet→portfolio top-ups: hold the money from OPERATIONAL FLOAT at
 * request time, so it cannot be spent while the top-up waits to be applied.
 *
 * Hold    = wallet cash_out (partner_funding, float bucket) + platform cash_in
 *           (pending_portfolio_topup) — the money leaves the spendable float and
 *           is parked as pending capital.
 * Release = the exact reverse, used on reject/cancel.
 * Apply   = merge_paidout_topups / manual apply release the parked platform leg
 *           into partner_funding; no wallet leg (the money already left).
 *
 * Same legs and bucket as create-portfolio-invite (float, never withdrawable).
 *
 * Op metadata contract (pending_wallet_operations.metadata):
 *   fund_source: 'float'
 *   float_hold:  'pending' (op recorded, ledger not yet posted)
 *              | 'held'    (money is out of the wallet, parked)
 *              | 'released' (returned to float on reject/cancel)
 *   source_wallet_user_id: wallet the hold was taken from
 * Engines must never apply an op whose float_hold is set but not 'held'.
 */

export const topupHoldKey = (opId: string) => `portfolio-topup-hold-${opId}`;
export const topupReleaseKey = (opId: string) => `portfolio-topup-release-${opId}`;

interface LegOpts {
  walletUserId: string;
  partnerId: string;
  amount: number;
  portfolioId: string;
  portfolioCode: string;
  label: string;
  note?: string;
}

export function topupHoldEntries(o: LegOpts) {
  return [
    {
      user_id: o.walletUserId,
      amount: o.amount,
      direction: "cash_out",
      category: "partner_funding",
      ledger_scope: "wallet",
      recipient_type: "operational_wallet",
      wallet_bucket: "float",
      source_table: "investor_portfolios",
      source_id: o.portfolioId,
      reference_id: o.portfolioCode,
      linked_party: "platform",
      description: `Operational float held for pending top-up of ${o.label} (${o.portfolioCode})`,
      currency: "UGX",
    },
    {
      user_id: o.partnerId,
      amount: o.amount,
      direction: "cash_in",
      category: "pending_portfolio_topup",
      ledger_scope: "platform",
      source_table: "investor_portfolios",
      source_id: o.portfolioId,
      reference_id: o.portfolioCode,
      linked_party: o.walletUserId,
      description: `Pending top-up capital parked for ${o.label} — applies at next Returns payout`,
      currency: "UGX",
    },
  ];
}

export function topupReleaseEntries(o: LegOpts) {
  const why = o.note ? ` Reason: ${o.note}` : "";
  return [
    {
      user_id: o.partnerId,
      amount: o.amount,
      direction: "cash_out",
      category: "pending_portfolio_topup",
      ledger_scope: "platform",
      source_table: "investor_portfolios",
      source_id: o.portfolioId,
      reference_id: o.portfolioCode,
      linked_party: o.walletUserId,
      description: `Pending top-up for ${o.label} released — parked capital returned.${why}`,
      currency: "UGX",
    },
    {
      user_id: o.walletUserId,
      amount: o.amount,
      direction: "cash_in",
      category: "partner_funding",
      ledger_scope: "wallet",
      recipient_type: "operational_wallet",
      wallet_bucket: "float",
      source_table: "investor_portfolios",
      source_id: o.portfolioId,
      reference_id: o.portfolioCode,
      linked_party: "platform",
      description: `Held top-up for ${o.label} returned to operational float.${why}`,
      currency: "UGX",
    },
  ];
}
