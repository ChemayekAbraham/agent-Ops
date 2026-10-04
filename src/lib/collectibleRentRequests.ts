/**
 * Single definition of "this tenant can actually be collected from today".
 *
 * Mirrors the server-side law in `v_agent_daily_eligibility` so the agent's
 * owing/collection list, the daily target and Agent Ops ratings all agree.
 *
 * Why this exists: `total_repayment` / `daily_repayment` are written when the
 * rent request is CREATED, long before the CFO disburses. Any query that filters
 * by status blacklist (e.g. `!= 'rejected'`) therefore reads a debt that does
 * not exist yet and shows unfunded tenants as owing.
 */

/** Statuses where company money has actually left the platform. */
export const COLLECTIBLE_STATUSES = ['funded', 'disbursed', 'repaying', 'completed'] as const;

export function isCollectibleStatus(status?: string | null): boolean {
  return !!status && (COLLECTIBLE_STATUSES as readonly string[]).includes(status);
}

export interface AllocationSettlement {
  /** Number of allocations still `status = 'open'` for this rent request. */
  openAllocations: number;
  /** Total paid out to the landlord across this request's allocations. */
  paidOutAmount: number;
}

/**
 * Disbursement evidence test, identical to `v_agent_daily_eligibility`:
 * the landlord has been settled, OR the tenant has already repaid something,
 * OR there is no open allocation blocking settlement.
 */
export function hasDisbursementEvidence(
  amountRepaid: number,
  settlement?: AllocationSettlement,
): boolean {
  if (amountRepaid > 0) return true;
  if (!settlement) return true; // no allocation rows at all
  if (settlement.paidOutAmount > 0) return true;
  return settlement.openAllocations === 0;
}
