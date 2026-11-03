import { describe, it, expect } from 'vitest';
import { groupPayoutRows, type PayoutGroupRow } from './payoutDeskGrouping';
import type { RentDeskOrder, RentDeskOrderRow } from '@/hooks/useRentDeskOrder';

const row = (id: string, agent: string, created: string): PayoutGroupRow => ({
  id, created_at: created, agent_id: agent, assigned_agent_id: null, agent_name: `Agent ${agent}`,
});
const order = (ranks: Record<string, number>): RentDeskOrder => ({
  sort: 'best_payers', filtered: false, matchCount: Object.keys(ranks).length, totalCount: Object.keys(ranks).length,
  byId: new Map(Object.entries(ranks).map(([id, rank]) => [id, { request_id: id, tenant_id: `t-${id}`, rank, score: 100 - rank, label: 'average', reason: null, basis: 'new', matches: true, match_count: 0, total_count: 0 } as RentDeskOrderRow])),
});

// a1 has the newest request; a2 has the best-paying tenant
const rows = [
  row('r1', 'a1', '2026-10-10T08:00:00Z'),
  row('r2', 'a1', '2026-10-13T08:00:00Z'),
  row('r3', 'a2', '2026-10-05T08:00:00Z'),
  row('r4', 'a2', '2026-10-06T08:00:00Z'),
  row('r5', 'a3', '2026-10-12T08:00:00Z'),
];

describe('payout desk grouping', () => {
  it('without a server order keeps the previous layout: the agent with the newest request first, each agent\'s newest request first', () => {
    const g = groupPayoutRows(rows);
    expect(g.map((x) => x.agent_id)).toEqual(['a1', 'a3', 'a2']);
    expect(g[0].rows.map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(g[2].rows.map((r) => r.id)).toEqual(['r4', 'r3']);
  });

  it('with the best-payers order, good payers are listed first and agents by their best tenant', () => {
    const g = groupPayoutRows(rows, order({ r3: 1, r2: 2, r5: 3, r1: 4, r4: 5 }));
    expect(g.map((x) => x.agent_id)).toEqual(['a2', 'a1', 'a3']);
    expect(g[0].rows.map((r) => r.id)).toEqual(['r3', 'r4']);
    expect(g[1].rows.map((r) => r.id)).toEqual(['r2', 'r1']);
  });

  it('with the newest order it gives the same layout as no order at all', () => {
    const newest = order({ r2: 1, r5: 2, r1: 3, r4: 4, r3: 5 });
    expect(groupPayoutRows(rows, newest).map((x) => [x.agent_id, x.rows.map((r) => r.id)]))
      .toEqual(groupPayoutRows(rows).map((x) => [x.agent_id, x.rows.map((r) => r.id)]));
  });

  it('puts rows the server did not rank after the ranked ones, and an all-unranked agent last', () => {
    const g = groupPayoutRows(rows, order({ r1: 1, r2: 2 }));
    expect(g.map((x) => x.agent_id)).toEqual(['a1', 'a3', 'a2']);
    expect(g[2].rows.map((r) => r.id)).toEqual(['r4', 'r3']);
  });

  it('shows exactly the same rows in either layout, and never mutates its input', () => {
    const before = rows.map((r) => r.id);
    const ids = (g: ReturnType<typeof groupPayoutRows>) => g.flatMap((x) => x.rows.map((r) => r.id)).sort();
    expect(ids(groupPayoutRows(rows, order({ r3: 1, r2: 2, r5: 3, r1: 4, r4: 5 })))).toEqual(ids(groupPayoutRows(rows)));
    expect(rows.map((r) => r.id)).toEqual(before);
  });

  it('groups a plan by its assigned agent before its agent', () => {
    const g = groupPayoutRows([{ ...row('x', 'a1', '2026-10-01T00:00:00Z'), assigned_agent_id: 'a9' }]);
    expect(g[0].agent_id).toBe('a9');
    expect(groupPayoutRows([{ ...row('y', 'a1', '2026-10-01T00:00:00Z'), agent_id: null }])[0].agent_id).toBe('unassigned');
  });

  it('with the agent collection % sort, agents are listed highest % first, those with no figure last, ties in the layout above', () => {
    const pct: Record<string, number | null> = { a1: 40, a2: 90, a3: null };
    const g = groupPayoutRows(rows, order({ r1: 1, r2: 2, r3: 3, r4: 4, r5: 5 }), (r) => pct[r.agent_id as string] ?? null);
    expect(g.map((x) => x.agent_id)).toEqual(['a2', 'a1', 'a3']);
    // inside a group the server order is unchanged
    expect(g[0].rows.map((r) => r.id)).toEqual(['r3', 'r4']);
    // equal % falls back to the best-ranked tenant
    const tie = groupPayoutRows(rows, order({ r1: 3, r2: 4, r3: 1, r4: 2, r5: 5 }), () => 50);
    expect(tie.map((x) => x.agent_id)).toEqual(['a2', 'a1', 'a3']);
  });

  it('applies the agent collection % even before the server order has loaded', () => {
    const pct: Record<string, number | null> = { a1: 10, a2: 20, a3: 30 };
    expect(groupPayoutRows(rows, undefined, (r) => pct[r.agent_id as string] ?? null).map((x) => x.agent_id)).toEqual(['a3', 'a2', 'a1']);
  });

  it('a group takes the highest % among its rows (an older request whose assigned agent differs)', () => {
    const mixed: PayoutGroupRow[] = [
      { id: 'x1', created_at: '2026-10-01T00:00:00Z', agent_id: 'reg1', assigned_agent_id: 'asg', agent_name: 'Assigned' },
      { id: 'x2', created_at: '2026-10-02T00:00:00Z', agent_id: 'reg2', assigned_agent_id: 'asg', agent_name: 'Assigned' },
      { id: 'y1', created_at: '2026-10-03T00:00:00Z', agent_id: 'other', assigned_agent_id: null, agent_name: 'Other' },
    ];
    const pct: Record<string, number> = { reg1: 20, reg2: 80, other: 50 };
    expect(groupPayoutRows(mixed, undefined, (r) => pct[r.agent_id as string]).map((x) => x.agent_id)).toEqual(['asg', 'other']);
  });
});
