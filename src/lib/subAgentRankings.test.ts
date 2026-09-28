import { describe, expect, it } from 'vitest';
import { rentPlan as plan, subAgentFixture } from '@/test/fixtures/serviceCenter';
import {
  isCollectiblePlan,
  measureSubAgent,
  rankSubAgents,
  summariseSubAgentRankings,
} from '@/lib/subAgentRankings';

const subAgent = subAgentFixture;

describe('isCollectiblePlan', () => {
  it('counts a funded plan the sub-agent owns', () => {
    expect(isCollectiblePlan(plan())).toBe(true);
  });

  it('skips referral-only plans so the same money is not credited twice', () => {
    expect(isCollectiblePlan(plan({ owned_by_subagent: false }))).toBe(false);
  });

  it('skips profile placeholders that have no rent request', () => {
    expect(isCollectiblePlan(plan({ rent_request_id: 'profile:abc' }))).toBe(false);
  });

  it('skips plans that never disbursed', () => {
    expect(
      isCollectiblePlan(plan({ status: 'service_center_review', is_active: false, amount_repaid: 0 })),
    ).toBe(false);
  });

  it('keeps a closed plan that already collected money', () => {
    expect(
      isCollectiblePlan(plan({ status: 'completed', is_active: false, amount_repaid: 1_000_000 })),
    ).toBe(true);
  });

  it('keeps plans from older payloads that omit owned_by_subagent', () => {
    const legacy = plan();
    delete legacy.owned_by_subagent;
    expect(isCollectiblePlan(legacy)).toBe(true);
  });
});

describe('measureSubAgent', () => {
  it('sums collections, arrears and the daily target across creditable plans', () => {
    const row = measureSubAgent(
      subAgent('a', [
        plan({ total_repayment: 1_000_000, amount_repaid: 400_000, daily_repayment: 10_000 }),
        plan({ total_repayment: 500_000, amount_repaid: 500_000, daily_repayment: 5_000, is_active: false }),
        // Excluded: still in vetting.
        plan({ total_repayment: 900_000, amount_repaid: 0, is_active: false, status: 'pending' }),
      ]),
    );

    expect(row.collected).toBe(900_000);
    expect(row.expected).toBe(1_500_000);
    expect(row.outstanding).toBe(600_000);
    expect(row.collectionRate).toBe(60);
    expect(row.plans).toBe(2);
    expect(row.activePlans).toBe(1);
    expect(row.clearedPlans).toBe(1);
    // Only the still-repaying plan contributes to today's target.
    expect(row.dailyTarget).toBe(10_000);
  });

  it('coerces string and null numerics from the JSON payload', () => {
    const row = measureSubAgent(
      subAgent('a', [
        plan({
          total_repayment: '1000000' as unknown as number,
          amount_repaid: '250000' as unknown as number,
          daily_repayment: null,
        }),
      ]),
    );

    expect(row.collected).toBe(250_000);
    expect(row.expected).toBe(1_000_000);
    expect(row.dailyTarget).toBe(0);
  });

  it('reports no rate rather than 0% when nothing is due', () => {
    const row = measureSubAgent(subAgent('a', []));
    expect(row.collectionRate).toBeNull();
    expect(row.outstanding).toBe(0);
  });

  it('never reports negative arrears when a tenant overpays', () => {
    const row = measureSubAgent(
      subAgent('a', [plan({ total_repayment: 100_000, amount_repaid: 130_000 })]),
    );
    expect(row.outstanding).toBe(0);
  });
});

describe('rankSubAgents', () => {
  const top = subAgent('a', [plan({ total_repayment: 1_000_000, amount_repaid: 900_000 })]);
  const middle = subAgent('b', [plan({ total_repayment: 1_000_000, amount_repaid: 500_000 })]);
  const bottom = subAgent('c', [plan({ total_repayment: 2_000_000, amount_repaid: 100_000 })]);

  it('ranks by rent collected, highest first', () => {
    const rows = rankSubAgents([bottom, middle, top], 'repaid');
    expect(rows.map((r) => r.subAgentId)).toEqual(['a', 'b', 'c']);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('ranks by collection rate independently of plan size', () => {
    const rows = rankSubAgents([bottom, middle, top], 'rate');
    expect(rows.map((r) => r.subAgentId)).toEqual(['a', 'b', 'c']);
    expect(rows.map((r) => Math.round(r.collectionRate ?? 0))).toEqual([90, 50, 5]);
  });

  it('puts the biggest arrears first in outstanding mode', () => {
    const rows = rankSubAgents([top, middle, bottom], 'outstanding');
    expect(rows.map((r) => r.subAgentId)).toEqual(['c', 'b', 'a']);
    expect(rows[0].outstanding).toBe(1_900_000);
  });

  it('sorts sub-agents with nothing due below everyone who has collections', () => {
    const idle = subAgent('z', []);
    const rows = rankSubAgents([idle, bottom], 'rate');
    expect(rows.map((r) => r.subAgentId)).toEqual(['c', 'z']);
    expect(rows[1].collectionRate).toBeNull();
  });

  it('shares a rank on ties and skips the consumed positions', () => {
    const tieA = subAgent('t1', [plan({ total_repayment: 100_000, amount_repaid: 50_000 })], {
      full_name: 'Aisha',
    });
    const tieB = subAgent('t2', [plan({ total_repayment: 100_000, amount_repaid: 50_000 })], {
      full_name: 'Bosco',
    });
    const lower = subAgent('t3', [plan({ total_repayment: 100_000, amount_repaid: 10_000 })], {
      full_name: 'Carol',
    });

    const rows = rankSubAgents([lower, tieB, tieA], 'repaid');
    expect(rows.map((r) => r.rank)).toEqual([1, 1, 3]);
    // Deterministic order within the tie keeps the board stable across refetches.
    expect(rows.map((r) => r.name)).toEqual(['Aisha', 'Bosco', 'Carol']);
  });

  it('is stable when called twice on a reshuffled roster', () => {
    const first = rankSubAgents([top, bottom, middle], 'repaid').map((r) => r.subAgentId);
    const second = rankSubAgents([middle, top, bottom], 'repaid').map((r) => r.subAgentId);
    expect(first).toEqual(second);
  });

  it('returns nothing for an empty roster', () => {
    expect(rankSubAgents([], 'repaid')).toEqual([]);
  });
});

describe('summariseSubAgentRankings', () => {
  it('recomputes the team rate from totals instead of averaging rows', () => {
    const rows = rankSubAgents(
      [
        subAgent('a', [plan({ total_repayment: 1_000_000, amount_repaid: 900_000, daily_repayment: 10_000 })]),
        subAgent('b', [plan({ total_repayment: 3_000_000, amount_repaid: 300_000, daily_repayment: 20_000 })]),
        subAgent('c', []),
      ],
      'repaid',
    );

    const summary = summariseSubAgentRankings(rows);
    expect(summary.subAgents).toBe(3);
    // Only sub-agents with at least one creditable plan are "ranked".
    expect(summary.ranked).toBe(2);
    expect(summary.collected).toBe(1_200_000);
    expect(summary.expected).toBe(4_000_000);
    expect(summary.outstanding).toBe(2_800_000);
    expect(summary.collectionRate).toBe(30);
    expect(summary.dailyTarget).toBe(30_000);
    expect(summary.plans).toBe(2);
  });

  it('reports no rate for a team with nothing due', () => {
    const summary = summariseSubAgentRankings(rankSubAgents([subAgent('a', [])], 'repaid'));
    expect(summary.collectionRate).toBeNull();
    expect(summary.collected).toBe(0);
  });
});
