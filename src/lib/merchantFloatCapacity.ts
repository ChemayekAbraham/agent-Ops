import type { MerchantFloatAllocationRow } from '@/hooks/useMerchantAgentFloatAllocation';

/**
 * Recommended daily float capacity per merchant agent — derived ONLY from the
 * ledger-verified performance report (`merchant_agent_float_allocation_report`).
 *
 * Nothing here moves money or writes anywhere: it is a recommendation layer
 * that turns past performance into "how much can this desk safely handle today",
 * and then splits a Financial-Ops-entered distribution pot across desks in
 * proportion to that earned capacity.
 */
export interface MerchantCapacity {
  agentId: string;
  /** Average verified payout value per day inside the report window. */
  dailyThroughput: number;
  /** Performance multiplier (0 = blocked, 1.25 = top performer). */
  factor: number;
  /** Earned daily capacity from performance alone, before any pot is entered. */
  earnedCapacity: number;
  /** Share of the entered distribution pot (0 when no pot entered). */
  suggestedAllocation: number;
  /** Float already sitting with them that the pot does not need to replace. */
  availableFloat: number;
  /** Top-up needed to bring them up to their earned capacity. */
  topUpNeeded: number;
  score: number;
  recommendation: MerchantFloatAllocationRow['recommendation'];
  reason: string;
  blocker: string | null;
  /** Capacity earned from performance alone, ignoring any admin override. */
  performanceCapacity: number;
  /** Active admin override in force for this desk, if any. */
  override: MerchantCapacityOverrideInput | null;
}

/** A temporary Financial-Ops override in force for one desk. */
export interface MerchantCapacityOverrideInput {
  id: string;
  capacity: number;
  reason: string;
  expiresAt: string;
  setBy?: string;
}

const round = (n: number, step = 5000) => Math.max(0, Math.round(n / step) * step);

/** Performance multiplier from the allocation score + explicit recommendation. */
export function performanceFactor(r: MerchantFloatAllocationRow): number {
  if (r.blocker) return 0;
  if (!r.isActive) return 0;
  const scoreFactor = Math.min(1.25, Math.max(0.15, (r.allocationScore || 0) / 80));
  switch (r.recommendation) {
    case 'increase':
      return Math.min(1.25, scoreFactor * 1.15);
    case 'maintain':
      return scoreFactor;
    case 'reduce_or_freeze':
      return Math.min(scoreFactor, 0.35);
    default:
      return Math.min(scoreFactor, 0.5);
  }
}

export function computeMerchantCapacities(
  rows: MerchantFloatAllocationRow[],
  potAmount: number,
  overrides?: Map<string, MerchantCapacityOverrideInput>,
): Map<string, MerchantCapacity> {
  const base = rows.map((r) => {
    const days = Math.max(1, r.windowDays || 30);
    const dailyThroughput = Math.max(0, r.totalPaid) / days;
    const factor = performanceFactor(r);
    // A desk with no history yet still gets a small starter capacity so it can
    // build a record, but only when nothing blocks it.
    const starter = factor > 0 && dailyThroughput === 0 ? 50_000 : 0;
    const performanceCapacity = round(dailyThroughput * factor + starter);
    // A temporary override replaces the earned figure for as long as it is in
    // force. It stays a recommendation: it moves no money by itself.
    const override = overrides?.get(r.agentId) ?? null;
    const earnedCapacity = override ? round(override.capacity, 1000) : performanceCapacity;
    return { r, dailyThroughput, factor, earnedCapacity, performanceCapacity, override };
  });

  const weightTotal = base.reduce((s, b) => s + b.earnedCapacity, 0);
  const pot = Number.isFinite(potAmount) && potAmount > 0 ? potAmount : 0;

  const out = new Map<string, MerchantCapacity>();
  base.forEach((b) => {
    const share =
      pot > 0 && weightTotal > 0 ? round((b.earnedCapacity / weightTotal) * pot, 1000) : 0;
    out.set(b.r.agentId, {
      agentId: b.r.agentId,
      dailyThroughput: b.dailyThroughput,
      factor: b.factor,
      earnedCapacity: b.earnedCapacity,
      suggestedAllocation: share,
      availableFloat: Math.max(0, b.r.availableFloat),
      topUpNeeded: Math.max(0, b.earnedCapacity - Math.max(0, b.r.availableFloat)),
      score: b.r.allocationScore,
      recommendation: b.r.recommendation,
      reason: b.r.reason,
      blocker: b.r.blocker,
      performanceCapacity: b.performanceCapacity,
      override: b.override,
    });
  });
  return out;
}


export const capacityLabel = (c: MerchantCapacity | undefined): string => {
  if (!c) return 'no performance record yet';
  if (c.blocker) return `blocked — ${c.blocker}`;
  switch (c.recommendation) {
    case 'increase':
      return 'strong record — can take more';
    case 'maintain':
      return 'steady record — keep at this level';
    case 'reduce_or_freeze':
      return 'weak record — reduce or hold';
    default:
      return 'not enough history — starter capacity';
  }
};
