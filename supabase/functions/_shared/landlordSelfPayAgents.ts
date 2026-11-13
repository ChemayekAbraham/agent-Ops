// Agents allowed to pay their assigned landlords themselves from their
// Landlord Float (chemayek abraham, 12 Nov 2026: Alpha Ssema only).
// The landlord one-time code still applies. The location (GPS proximity)
// check is skipped for these agents so they can pay landlords remotely
// (chemayek abraham, 12 Nov 2026). The payout
// skips the merchant queue, debits only the Landlord Float (never the
// withdrawable wallet) and waits for the agent's transaction ID and receipt.
export const LANDLORD_SELF_PAY_AGENT_IDS: ReadonlySet<string> = new Set([
  "9188db01-e54a-4f84-8de9-042e6b5b6bd6", // ALPHA SSEMA
]);

export function canSelfPayLandlords(agentId: string | null | undefined): boolean {
  return !!agentId && LANDLORD_SELF_PAY_AGENT_IDS.has(agentId);
}
