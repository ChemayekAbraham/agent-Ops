/**
 * Money We Owe / Money We Can Use for the CFO Cash Position cards.
 *
 * Money moves Welile Technologies -> Bayo Mercy's Equity account -> merchant
 * agent (Catherine). Each leg that leaves Money We Have becomes Money We Owe;
 * as merchant agents claim and pay withdrawals it comes back down. Money We
 * Owe is therefore never negative.
 *
 * The Bayo Mercy balance is the Equity-email credits less debits and CAN dip
 * below zero: Mercy pays the merchant before Welile's top-up lands (observed
 * 1, 2, 5 and 6 Oct 2026). A negative balance is not a negative debt. It is
 * money Mercy has fronted from her own funds, and that money is already inside
 * the merchant float, so the commitment is `merchantFloat + max(0, bayo)`.
 * The fronted amount is reported separately and is NOT subtracted again.
 */
export interface CashPositionInput {
  moneyWeHave: number;
  /** Merchant float bucket (already floored at 0 per agent by the RPC). */
  merchantFloat: number;
  /** Bayo Mercy account balance from the email extractor; may be negative. */
  bayoMercyBalance: number;
}

export interface CashPosition {
  moneyWeOwe: number;
  moneyWeCanUse: number;
  /** Bayo Mercy balance counted as owed (never below 0). */
  bayoMercyOwed: number;
  /** Money Mercy fronted ahead of Welile's top-up; informational, already inside merchantFloat. */
  mercyFrontedPendingTopUp: number;
}

const finite = (n: number) => (Number.isFinite(n) ? n : 0);

export function computeCashPosition(input: CashPositionInput): CashPosition {
  const moneyWeHave = finite(input.moneyWeHave);
  const merchantFloat = Math.max(0, finite(input.merchantFloat));
  const bayo = finite(input.bayoMercyBalance);

  const bayoMercyOwed = Math.max(0, bayo);
  const mercyFrontedPendingTopUp = Math.max(0, -bayo);
  const moneyWeOwe = merchantFloat + bayoMercyOwed;
  const moneyWeCanUse = Math.min(moneyWeHave, Math.max(0, moneyWeHave - moneyWeOwe));

  return { moneyWeOwe, moneyWeCanUse, bayoMercyOwed, mercyFrontedPendingTopUp };
}
