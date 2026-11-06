import { describe, expect, it } from 'vitest';
import {
  balanceOf,
  defaultPlanOrder,
  fmtUgx,
  pct,
  recoveredSplit,
  rollUpByAgent,
  toPlan,
  toSummary,
  type CtoControlledPlan,
} from './ctoControlledPlans';

const plan = (over: Partial<CtoControlledPlan>): CtoControlledPlan => ({
  rentRequestId: 'p', tenantName: 'T', agentId: 'a1', agentName: 'Agent One', fundedOn: '2026-10-19', durationDays: 30, status: 'repaying',
  given: 200000, formulaDue: 276000, recovered: 0, collectionCount: 0, lastCollectionOn: null, partnerEarned: 0, platformEarned: 0,
  agentCommission: 0, feesDrawn: 0, principalBack: 0, expectedPartner: 0, expectedAgent: 0, daysOverdue: 0, counterMismatch: false, collectionsSum: 0,
  ...over,
});

describe('ctoControlledPlans helpers', () => {
  it('formats UGX with thousands separators', () => {
    expect(fmtUgx(1234567)).toBe('UGX 1,234,567');
    expect(fmtUgx(0)).toBe('UGX 0');
    expect(fmtUgx(999.6)).toBe('UGX 1,000');
  });

  it('pct is one decimal and safe on a zero whole', () => {
    expect(pct(2361301, 59841584)).toBe(3.9);
    expect(pct(5, 0)).toBe(0);
  });

  it('balance is never negative', () => {
    expect(balanceOf(plan({ formulaDue: 100, recovered: 150 }))).toBe(0);
    expect(balanceOf(plan({ formulaDue: 276000, recovered: 76000 }))).toBe(200000);
  });

  it('maps database rows, treating nulls as zero', () => {
    const p = toPlan({ rent_request_id: 'x', given: '600000.00', formula_due: '818000.00', recovered: null, counter_mismatch: false });
    expect(p.given).toBe(600000);
    expect(p.recovered).toBe(0);
    expect(p.tenantName).toBe('(no name)');
    expect(toSummary(undefined).plansCount).toBe(0);
  });

  it('the stacked-bar split adds up to the recovered cash (principal + partner + agent + platform)', () => {
    // live figures, 2026-10-24: recovered 2,361,301 = principal 1,740,067 + partner 260,987 + agent 236,129 + platform 124,118
    const s = toSummary({ recovered: 2361301, principal_back: 1740067, partner_earned: 260987, agent_commission: 236129, platform_earned: 124118 });
    expect(recoveredSplit(s).reduce((t, x) => t + x.amount, 0)).toBe(s.recovered);
  });

  it('rolls up by agent, biggest recovered first', () => {
    const rows = rollUpByAgent([
      plan({ agentId: 'a1', agentName: 'Agent One', recovered: 10, agentCommission: 1 }),
      plan({ agentId: 'a2', agentName: 'Agent Two', recovered: 50, agentCommission: 5 }),
      plan({ agentId: 'a1', agentName: 'Agent One', recovered: 20, agentCommission: 2 }),
    ]);
    expect(rows.map((r) => [r.agentName, r.plans, r.recovered, r.agentCommission])).toEqual([
      ['Agent Two', 1, 50, 5],
      ['Agent One', 2, 30, 3],
    ]);
  });

  it('default order is days overdue, then the largest balance', () => {
    const a = plan({ tenantName: 'A', daysOverdue: 5, formulaDue: 100000, recovered: 0 });
    const b = plan({ tenantName: 'B', daysOverdue: 5, formulaDue: 300000, recovered: 0 });
    const c = plan({ tenantName: 'C', daysOverdue: 0, formulaDue: 900000, recovered: 0 });
    expect([a, c, b].sort(defaultPlanOrder).map((p) => p.tenantName)).toEqual(['B', 'A', 'C']);
  });
});
