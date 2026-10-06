import { describe, it, expect } from 'vitest';
import { compareWithHome, homeDifferenceMessage, homeFigures, type TabSummaryForCheck } from './paymentBehaviorHomeCheck';

const tab = (over: Partial<{ billed: number; self: number; agent: number; other: number; short: number; pct: number | null }> = {}): TabSummaryForCheck => ({
  payments: { self: { ugx: over.self ?? 673_724 }, agent: { ugx: over.agent ?? 9_436_044 }, other: { ugx: over.other ?? 0 } },
  coverage: { billed_ugx: over.billed ?? 52_450_581, short_ugx: over.short ?? 42_340_813, coverage_pct: over.pct === undefined ? 19.3 : over.pct },
});
const home = { expected: 52_450_581, collected: 10_109_768 };
const money = (n: number) => `UGX ${n.toLocaleString('en-US')}`;

describe('homeFigures', () => {
  it('shows short and % covered the way Tenant Ops Home does', () => {
    expect(homeFigures(home)).toEqual({ expected: 52_450_581, collected: 10_109_768, short: 42_340_813, coveragePct: 19 });
    expect(homeFigures({ expected: 100, collected: 250 })).toMatchObject({ short: 0, coveragePct: 100 });
    expect(homeFigures({ expected: 0, collected: 0 })).toMatchObject({ short: 0, coveragePct: 0 });
  });
});

describe('compareWithHome', () => {
  it('matches when billed, counted (self + agent + other) and short agree with Home', () => {
    const c = compareWithHome(home, tab());
    expect(c.status).toBe('match');
    expect(c.maxUgxDiff).toBe(0);
    expect(c.tab.collected).toBe(10_109_768);
  });

  it('adds the other channel into counted', () => {
    expect(compareWithHome({ expected: 100, collected: 60 }, tab({ billed: 100, self: 10, agent: 40, other: 10, short: 40, pct: 60 })).status).toBe('match');
  });

  it('tolerates UGX 1 but not more', () => {
    expect(compareWithHome(home, tab({ agent: 9_436_045 })).status).toBe('match');
    const off = compareWithHome(home, tab({ agent: 9_436_046 }));
    expect(off.status).toBe('differ');
    expect(off.maxUgxDiff).toBe(2);
  });

  it('flags a difference in any one figure and reports the largest UGX gap', () => {
    const c = compareWithHome(home, tab({ billed: 52_450_581 + 5_179_918, short: 42_340_813 + 5_179_918 }));
    expect(c.status).toBe('differ');
    expect(c.maxUgxDiff).toBe(5_179_918);
    expect(homeDifferenceMessage(c, money)).toBe('These figures differ from Tenant Ops Home by UGX 5,179,918. Home is the reference.');
  });

  it('flags a % covered gap larger than rounding even when the money agrees', () => {
    const c = compareWithHome(home, tab({ pct: 25 }));
    expect(c.status).toBe('differ');
    expect(homeDifferenceMessage(c, money)).toContain('percentage points on % covered');
    expect(compareWithHome(home, tab({ pct: 19.4 })).status).toBe('match');
  });
});
