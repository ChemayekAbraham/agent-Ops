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

// Wallet-to-bank charge tiers (MTN MoMo schedule; Airtel is identical above
// UGX 125,000 and cheaper below it). MUST stay in sync with the copy in
// `supabase/functions/approve-withdrawal/index.ts`. MTN does not allow bank
// transfers under UGX 2,501; smaller amounts take the 1,500 floor.
export const BANK_CHARGE_TIERS: { min: number; max: number; charge: number }[] = [
  { min: 0, max: 125_000, charge: 1_500 },
  { min: 125_001, max: 250_000, charge: 2_250 },
  { min: 250_001, max: 500_000, charge: 4_100 },
  { min: 500_001, max: 1_000_000, charge: 6_150 },
  { min: 1_000_001, max: 2_000_000, charge: 9_250 },
  { min: 2_000_001, max: 5_000_000, charge: 11_300 },
];

// Sending charge levied by the telecom house for a given amount. Bank payouts
// (`payoutMethod === 'bank_transfer'`) use the wallet-to-bank schedule; every
// other method keeps the mobile-money person-to-person schedule.
export function getTelecomSendingCharge(amount: number, payoutMethod?: string | null): number {
  const amt = Number(amount || 0);
  if (amt <= 0) return 0;
  const tiers = payoutMethod === 'bank_transfer' ? BANK_CHARGE_TIERS : TELECOM_CHARGE_TIERS;
  for (const t of tiers) {
    if (amt >= t.min && amt <= t.max) return t.charge;
  }
  // Above the top published tier — apply the highest published charge.
  if (amt > tiers[tiers.length - 1].max) {
    return tiers[tiers.length - 1].charge;
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
