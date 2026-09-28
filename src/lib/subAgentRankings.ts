/**
 * Ranking maths for the Service Center sub-agent rankings board.
 *
 * Everything is derived from the roster payload the Service Center page has
 * already loaded (`get_agent_service_center`), so the board costs no extra
 * round trip. Keeping the maths here — free of React and of Supabase — makes
 * the credit rules and tie-breaking unit-testable.
 */
import type { ServiceCenterSubAgent, ServiceCenterTenant } from '@/hooks/useAgentServiceCenter';

/** What the board sorts on. `outstanding` is a follow-up list, not a podium. */
export type SubAgentRankMetric = 'repaid' | 'rate' | 'outstanding';

export interface SubAgentRankRow {
  /** Competition rank on the active metric: equal scores share a rank. */
  rank: number;
  subAgentId: string;
  name: string;
  avatarUrl: string | null;
  suspended: boolean;
  /**
   * Σ `amount_repaid` across creditable rent plans, ALL TIME.
   *
   * This is the plan BALANCE, not the receipt book. `amount_repaid` has
   * fifteen writers — agent collection, deposit settlement, tenant self-
   * payment, ops balance edits, administrative completion — so it is what the
   * tenant has been credited with, from any route, since the plan was funded.
   * The metric is called `repaid` for that reason: calling it "collected"
   * implied the sub-agent personally took the cash, and on 2026-09-28 the
   * board was reading 13,350,179 for an agent whose own collections came to
   * 7,445,779.
   *
   * It is also why reversed collections could surface here long after the
   * reader-side sweep: a reversed row can be filtered, a column cannot. See
   * `docs/reversed-collections-surface-audit.md`.
   */
  collected: number;
  /** Σ `total_repayment` across creditable rent plans. */
  expected: number;
  /** `expected - collected`, floored at zero. */
  outstanding: number;
  /** 0-100+; `null` when nothing is due yet, so "no data" never reads as 0%. */
  collectionRate: number | null;
  /** Σ `daily_repayment` across still-repaying plans — today's collection target. */
  dailyTarget: number;
  /** Creditable rent plans (see {@link isCollectiblePlan}). */
  plans: number;
  /** Creditable plans still funded/repaying. */
  activePlans: number;
  /** Creditable plans repaid in full. */
  clearedPlans: number;
  /** The value this row was ranked on — what its headline figure shows. */
  score: number;
}

export interface SubAgentRankSummary {
  subAgents: number;
  ranked: number;
  collected: number;
  expected: number;
  outstanding: number;
  collectionRate: number | null;
  dailyTarget: number;
  plans: number;
  activePlans: number;
  clearedPlans: number;
}

/** Roster amounts arrive as JSON numerics, so they can be strings or null. */
const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * A rent plan counts toward a sub-agent's collections only when the plan is
 * really theirs and money is really due on it:
 *  - referral-only rows belong to whoever owns the plan, so counting them here
 *    would credit the same shillings to two sub-agents;
 *  - profile placeholders (a referred tenant with no rent request) have nothing
 *    to collect;
 *  - plans that never disbursed — still vetting, or rejected — would otherwise
 *    inflate `expected` and drag down an innocent sub-agent's collection rate.
 */
export function isCollectiblePlan(t: ServiceCenterTenant): boolean {
  // `owned_by_subagent` is absent on older payloads; only an explicit false
  // means "referral only".
  if (t.owned_by_subagent === false) return false;
  const id = t.rent_request_id;
  if (!id || id.startsWith('profile:')) return false;
  return t.is_active === true || num(t.amount_repaid) > 0;
}

/** Collection figures for one sub-agent, before any ranking is applied. */
export function measureSubAgent(subAgent: ServiceCenterSubAgent): Omit<SubAgentRankRow, 'rank' | 'score'> {
  const plans = (subAgent.tenant_list ?? []).filter(isCollectiblePlan);

  let collected = 0;
  let expected = 0;
  let dailyTarget = 0;
  let activePlans = 0;
  let clearedPlans = 0;

  for (const plan of plans) {
    const repaid = num(plan.amount_repaid);
    const total = num(plan.total_repayment);
    collected += repaid;
    expected += total;
    if (plan.is_active) {
      activePlans += 1;
      dailyTarget += num(plan.daily_repayment);
    }
    if (total > 0 && repaid >= total) clearedPlans += 1;
  }

  return {
    subAgentId: subAgent.sub_agent_id,
    name: subAgent.full_name ?? 'Unnamed sub-agent',
    avatarUrl: subAgent.avatar_url ?? null,
    suspended: !!subAgent.suspension,
    collected,
    expected,
    outstanding: Math.max(0, expected - collected),
    collectionRate: expected > 0 ? (collected / expected) * 100 : null,
    dailyTarget,
    plans: plans.length,
    activePlans,
    clearedPlans,
  };
}

/**
 * Score for the active metric. Sub-agents with nothing due cannot have a
 * collection rate, so they sort below everyone who does rather than above
 * everyone at 0%.
 */
function scoreFor(row: Omit<SubAgentRankRow, 'rank' | 'score'>, metric: SubAgentRankMetric): number {
  switch (metric) {
    case 'rate':
      return row.collectionRate ?? -1;
    case 'outstanding':
      return row.outstanding;
    case 'repaid':
    default:
      return row.collected;
  }
}

/**
 * Rank a roster by rent collected, collection rate or outstanding balance.
 *
 * Highest score first in every mode — in `outstanding` mode that puts the
 * biggest arrears at the top, which is the follow-up order a manager wants.
 * Ties share a rank (1, 2, 2, 4) and are ordered by collections then name, so
 * the board does not reshuffle between refetches.
 */
export function rankSubAgents(
  subAgents: ServiceCenterSubAgent[],
  metric: SubAgentRankMetric = 'repaid',
): SubAgentRankRow[] {
  const scored = subAgents.map((s) => {
    const measured = measureSubAgent(s);
    return { ...measured, score: scoreFor(measured, metric) };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.collected !== a.collected) return b.collected - a.collected;
    return a.name.localeCompare(b.name);
  });

  let rank = 0;
  let previousScore: number | null = null;
  return scored.map((row, index) => {
    if (previousScore === null || row.score !== previousScore) {
      rank = index + 1;
      previousScore = row.score;
    }
    return { ...row, rank };
  });
}

/** Team-wide totals for the board header. Rate is recomputed, never averaged. */
export function summariseSubAgentRankings(rows: SubAgentRankRow[]): SubAgentRankSummary {
  const totals = rows.reduce(
    (acc, r) => ({
      collected: acc.collected + r.collected,
      expected: acc.expected + r.expected,
      dailyTarget: acc.dailyTarget + r.dailyTarget,
      plans: acc.plans + r.plans,
      activePlans: acc.activePlans + r.activePlans,
      clearedPlans: acc.clearedPlans + r.clearedPlans,
      ranked: acc.ranked + (r.plans > 0 ? 1 : 0),
    }),
    { collected: 0, expected: 0, dailyTarget: 0, plans: 0, activePlans: 0, clearedPlans: 0, ranked: 0 },
  );

  return {
    subAgents: rows.length,
    ranked: totals.ranked,
    collected: totals.collected,
    expected: totals.expected,
    outstanding: Math.max(0, totals.expected - totals.collected),
    collectionRate: totals.expected > 0 ? (totals.collected / totals.expected) * 100 : null,
    dailyTarget: totals.dailyTarget,
    plans: totals.plans,
    activePlans: totals.activePlans,
    clearedPlans: totals.clearedPlans,
  };
}
