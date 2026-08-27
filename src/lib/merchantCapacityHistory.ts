import type {
  MerchantFloatAllocationEvidenceRow,
  MerchantFloatAllocationRow,
} from '@/hooks/useMerchantAgentFloatAllocation';
import { performanceFactor } from '@/lib/merchantFloatCapacity';

/**
 * Agent capacity history — how a merchant desk's qualified UGX/day moved over
 * time, rebuilt from the same ledger-verified payout evidence the live capacity
 * badge uses (`merchant_agent_float_allocation_evidence`).
 *
 * Read-only and derivation-only: no writes, no money movement, no new round
 * trips beyond the evidence query the drill-down already needs. For each day in
 * the window we take the trailing-window average verified payout value per day
 * and apply the SAME performance multiplier as the live capacity, so a point on
 * this chart is "what this desk would have qualified for on that day".
 */
export interface MerchantCapacityHistoryPoint {
  /** ISO date (yyyy-MM-dd) of the day being measured. */
  date: string;
  /** Verified payout value settled on that single day. */
  paidThatDay: number;
  /** Payout count on that single day. */
  payoutsThatDay: number;
  /** Trailing-window average verified payout value per day. */
  trailingDailyThroughput: number;
  /** Qualified capacity on that day (rounded the same way as live capacity). */
  capacity: number;
}

const round = (n: number, step = 5000) => Math.max(0, Math.round(n / step) * step);

const dayKey = (iso: string) => new Date(iso).toISOString().slice(0, 10);

/** Verified money moved by a payout — float principal, else the customer debit. */
const evidenceValue = (r: MerchantFloatAllocationEvidenceRow) =>
  Math.max(0, r.floatPrincipal > 0 ? r.floatPrincipal : r.customerDebit);

export function buildMerchantCapacityHistory(
  evidence: MerchantFloatAllocationEvidenceRow[],
  current: MerchantFloatAllocationRow | undefined,
  opts: { days: number; trailingWindow?: number } = { days: 90 },
): MerchantCapacityHistoryPoint[] {
  const days = Math.max(1, opts.days);
  const trailing = Math.max(1, opts.trailingWindow ?? Math.min(30, days));

  // One pass: bucket verified payout value per calendar day.
  const perDay = new Map<string, { amount: number; count: number }>();
  for (const r of evidence) {
    if (!r.createdAt) continue;
    const value = evidenceValue(r);
    if (value <= 0) continue;
    const key = dayKey(r.createdAt);
    const bucket = perDay.get(key);
    if (bucket) {
      bucket.amount += value;
      bucket.count += 1;
    } else {
      perDay.set(key, { amount: value, count: 1 });
    }
  }

  // The multiplier is a property of the desk's standing today (score, active
  // state, blockers) — it is not re-derivable per historic day, so the series
  // shows throughput-driven movement under today's standing.
  const factor = current ? performanceFactor(current) : 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  // Rolling sum over the trailing window — O(n), no nested scans.
  const out: MerchantCapacityHistoryPoint[] = [];
  let rolling = 0;
  for (let i = 0; i < dates.length; i++) {
    rolling += perDay.get(dates[i])?.amount ?? 0;
    if (i >= trailing) rolling -= perDay.get(dates[i - trailing])?.amount ?? 0;
    const spanned = Math.min(trailing, i + 1);
    const trailingDailyThroughput = rolling / spanned;
    const starter = factor > 0 && trailingDailyThroughput === 0 ? 50_000 : 0;
    const bucket = perDay.get(dates[i]);
    out.push({
      date: dates[i],
      paidThatDay: bucket?.amount ?? 0,
      payoutsThatDay: bucket?.count ?? 0,
      trailingDailyThroughput,
      capacity: round(trailingDailyThroughput * factor + starter),
    });
  }
  return out;
}

export interface MerchantCapacityHistorySummary {
  first: number;
  last: number;
  peak: number;
  low: number;
  change: number;
  changePct: number | null;
  direction: 'up' | 'down' | 'flat';
  activeDays: number;
}

export function summariseCapacityHistory(
  points: MerchantCapacityHistoryPoint[],
): MerchantCapacityHistorySummary | null {
  if (points.length === 0) return null;
  const caps = points.map((p) => p.capacity);
  const first = caps[0];
  const last = caps[caps.length - 1];
  const change = last - first;
  return {
    first,
    last,
    peak: Math.max(...caps),
    low: Math.min(...caps),
    change,
    changePct: first > 0 ? (change / first) * 100 : null,
    direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
    activeDays: points.filter((p) => p.payoutsThatDay > 0).length,
  };
}
