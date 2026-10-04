// Merchant (cash-out) agent economics — shared across the agent dashboard and
// the CFO Cash-Out Agents drill-down so both views show identical figures.

// Telecom sending charge tiers (Airtel to Airtel), by amount sent (UGX).
export const TELECOM_CHARGE_TIERS: { min: number; max: number; charge: number }[] = [
  { min: 0, max: 5_000, charge: 100 },
  { min: 5_001, max: 60_000, charge: 500 },
  { min: 60_001, max: 500_000, charge: 1_000 },
  { min: 500_001, max: 1_000_000, charge: 1_500 },
  { min: 1_000_001, max: 5_000_000, charge: 2_000 },
];

// Sending charge levied by the telecom house for a given amount.
export function getTelecomSendingCharge(amount: number): number {
  const amt = Number(amount || 0);
  if (amt <= 0) return 0;
  for (const t of TELECOM_CHARGE_TIERS) {
    if (amt >= t.min && amt <= t.max) return t.charge;
  }
  // Above the top published tier — apply the highest published charge.
  if (amt > TELECOM_CHARGE_TIERS[TELECOM_CHARGE_TIERS.length - 1].max) {
    return TELECOM_CHARGE_TIERS[TELECOM_CHARGE_TIERS.length - 1].charge;
  }
  return 0;
}

// Merchant commission rate on a settled payout (0.5%).
export const CASHOUT_COMMISSION_RATE = 0.005;

// Expected commission for an amount — used as a display fallback when the
// ledger leg has not yet been fetched. Actual credited commission always comes
// from the ledger (`<withdrawal_id>-cashout-commission`).
export function getCashoutCommission(amount: number): number {
  return Math.round(Number(amount || 0) * CASHOUT_COMMISSION_RATE);
}
