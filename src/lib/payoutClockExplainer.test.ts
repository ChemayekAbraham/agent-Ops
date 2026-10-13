import { describe, it, expect } from 'vitest';
import { PAYOUT_CLOCK_EXPLAINER, describeClockDrift, type ClockDriftStatus } from './payoutClockExplainer';

const status = (over: Partial<ClockDriftStatus> = {}): ClockDriftStatus => ({
  run_date: '2026-10-13', run_at: '2026-10-13T03:00:00Z', plans_checked: 957, plans_differ: 0, plans_explained: 0,
  due_diff_ugx: 0, arrears_diff_ugx: 0, ...over,
});

describe('PAYOUT_CLOCK_EXPLAINER', () => {
  it('is the agreed sentence', () => {
    expect(PAYOUT_CLOCK_EXPLAINER).toBe(
      "Repayments count from the day after the landlord's last payment. Plans whose landlord is not paid yet are listed separately.",
    );
  });
});

describe('describeClockDrift', () => {
  it('shows nothing until a check has run', () => {
    expect(describeClockDrift(null)).toBeNull();
    expect(describeClockDrift(undefined)).toBeNull();
  });

  it('says the pages agree, and mentions hand-set starts kept by decision', () => {
    expect(describeClockDrift(status())).toEqual({ agree: true, text: 'Pages agree · checked 2026-10-13' });
    expect(describeClockDrift(status({ plans_explained: 2 }))?.text).toBe('Pages agree · 2 hand-set starts kept · checked 2026-10-13');
    expect(describeClockDrift(status({ plans_explained: 1 }))?.text).toContain('1 hand-set start kept');
  });

  it('says how many plans differ', () => {
    expect(describeClockDrift(status({ plans_differ: 3 }))).toEqual({ agree: false, text: '3 plans differ · checked 2026-10-13' });
    expect(describeClockDrift(status({ plans_differ: 1 }))?.text).toBe('1 plan differs · checked 2026-10-13');
  });
});
