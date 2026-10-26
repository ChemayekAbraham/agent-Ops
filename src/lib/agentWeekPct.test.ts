import { describe, expect, it } from 'vitest';
import { agentWeekDetail, agentWeekSummary, chunkAgentWeekIds, formatWeekPct, normalizeAgentWeekPct, orderByAgentWeek, weekPctOf, weekRangeLabel } from './agentWeekPct';

const row = (o: Record<string, unknown> = {}) => ({
  agent_id: 'a1', week_start: '2026-10-22', week_end: '2026-10-28', through_day: '2026-10-25', book: 'mixed',
  in_window_plans: 4, in_window_collected: '125000', in_window_due_so_far: '160000', in_window_required_pct: '0.50',
  expired_plans: 2, expired_collected: '20000', expired_due_so_far: '40000', expired_required_pct: '0.20',
  last_week_start: '2026-10-15', last_week_end: '2026-10-21', last_book: 'mixed', last_in_window_pct: '0.7125', last_expired_pct: '0.4', last_passes: true, ...o,
});

describe('weekPctOf / formatWeekPct', () => {
  it('is collected over expected (Thursday through yesterday), to one decimal', () => {
    expect(weekPctOf(125000, 200000)).toBe(62.5);
    expect(formatWeekPct(weekPctOf(1, 3) as number)).toBe('33.3%');
    expect(formatWeekPct(weekPctOf(200000, 200000) as number)).toBe('100.0%');
  });
  it('has no figure when nothing has been expected yet', () => {
    expect(weekPctOf(0, 0)).toBeNull();
  });
});

describe('agentWeekSummary', () => {
  const [w] = normalizeAgentWeekPct([row()]);
  it('makes current Rent Plans the main figure and keeps expired as a second figure', () => {
    const s = agentWeekSummary(w);
    expect(s.primary?.group).toBe('current');
    // 125,000 collected of 160,000 expected from Thursday through yesterday
    expect(s.primary?.pct).toBeCloseTo(78.125, 6);
    expect(s.primary?.due).toBe(160000);
    expect(s.expired?.pct).toBe(50);
    expect(s.current?.required).toBe(0.5);
  });
  it('falls back to expired Rent Plans when the agent has no current ones', () => {
    const [x] = normalizeAgentWeekPct([row({ book: 'all_expired', in_window_plans: 0, in_window_collected: 0, in_window_due_so_far: 0, in_window_required_pct: null, expired_required_pct: '0.70' })]);
    expect(agentWeekSummary(x).primary?.group).toBe('expired');
    expect(agentWeekSummary(x).primary?.pct).toBe(50);
  });
  it('has no main figure for an agent with nothing expected yet', () => {
    const [x] = normalizeAgentWeekPct([row({ book: 'none', in_window_plans: 0, in_window_collected: 0, in_window_due_so_far: 0, expired_plans: 0, expired_collected: 0, expired_due_so_far: 0 })]);
    expect(agentWeekSummary(x).primary).toBeNull();
    expect(agentWeekSummary(null).primary).toBeNull();
  });
});

describe('agentWeekDetail', () => {
  it('names the week, the amounts, the target and last week', () => {
    const [w] = normalizeAgentWeekPct([row()]);
    const t = agentWeekDetail(w);
    expect(t).toContain('counted from Thu 22 Oct through yesterday (Sun 25 Oct)');
    expect(t).toContain('today is left out');
    expect(t).toContain('78.1%');
    expect(t).toContain('UGX 125,000 collected of UGX 160,000 expected');
    expect(t).toContain('Needs 50%');
    expect(t).toContain('Last week (Thu 15 Oct - Wed 21 Oct)');
    expect(t).toContain('current 71.3%');
  });
  it('says plainly when there is no figure', () => {
    const [w] = normalizeAgentWeekPct([row({ book: 'none', in_window_due_so_far: 0, in_window_collected: 0, expired_projected_due: 0, expired_due_so_far: 0, expired_collected: 0 })]);
    expect(agentWeekDetail(w)).toContain('no collection percentage');
    expect(agentWeekDetail(w)).toContain('from Thu 22 Oct through Sun 25 Oct');
    const [thu] = normalizeAgentWeekPct([row({ book: 'none', through_day: null, in_window_collected: 0, in_window_due_so_far: 0, expired_collected: 0, expired_due_so_far: 0 })]);
    expect(agentWeekDetail(thu)).toContain('restarted on Thu 22 Oct');
  });
});

describe('orderByAgentWeek', () => {
  const rows = [
    { id: 'r1', agent: 'low' }, { id: 'r2', agent: 'none' }, { id: 'r3', agent: 'high' }, { id: 'r4', agent: 'high' }, { id: 'r5', agent: 'mid' }, { id: 'r6', agent: null }, { id: 'r7', agent: 'low' },
  ];
  const pct = (collected: number, id: string) => row({ agent_id: id, in_window_collected: collected, in_window_due_so_far: 100, book: 'in_window_only', expired_plans: 0, expired_collected: 0, expired_due_so_far: 0 });
  const none = row({ agent_id: 'none', book: 'none', in_window_collected: 0, in_window_due_so_far: 0, expired_collected: 0, expired_due_so_far: 0 });
  const map = new Map(normalizeAgentWeekPct([pct(10, 'low'), pct(90, 'high'), pct(50, 'mid'), none]).map((w) => [w.agent_id, w]));

  it('orders by collected over expected through yesterday', () => {
    const a = normalizeAgentWeekPct([pct(50, 'a')])[0];
    const b = normalizeAgentWeekPct([pct(20, 'b')])[0];
    expect(agentWeekSummary(a).primary?.pct).toBe(50);
    expect(agentWeekSummary(b).primary?.pct).toBe(20);
  });

  it('puts the highest percentage on top, agents with no figure last', () => {
    expect(orderByAgentWeek(rows, map, (r) => r.agent).map((r) => r.id)).toEqual(['r3', 'r4', 'r5', 'r1', 'r7', 'r2', 'r6']);
  });
  it('keeps the incoming order between equal percentages', () => {
    const o = orderByAgentWeek(rows, map, (r) => r.agent).map((r) => r.id);
    expect(o.indexOf('r3')).toBeLessThan(o.indexOf('r4'));
    expect(o.indexOf('r1')).toBeLessThan(o.indexOf('r7'));
  });
  it('returns the rows unchanged while the figures have not loaded, and never mutates', () => {
    expect(orderByAgentWeek(rows, undefined, (r) => r.agent)).toBe(rows);
    expect(orderByAgentWeek(rows, new Map(), (r) => r.agent)).toBe(rows);
    const copy = [...rows];
    orderByAgentWeek(rows, map, (r) => r.agent);
    expect(rows).toEqual(copy);
  });
});

describe('helpers', () => {
  it('chunks ids and labels the week', () => {
    expect(chunkAgentWeekIds(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
    expect(weekRangeLabel('2026-10-22', '2026-10-28')).toBe('Thu 22 Oct - Wed 28 Oct');
  });
  it('ignores rows without an agent', () => {
    expect(normalizeAgentWeekPct([{}, null, row()])).toHaveLength(1);
  });
});
