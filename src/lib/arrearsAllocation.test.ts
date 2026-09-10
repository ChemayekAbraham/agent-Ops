import { describe, it, expect } from 'vitest';
import {
  hasArrears,
  splitPayment,
  arrearsHeadline,
  splitExplanation,
  totalDueNow,
  isPartialPayment,
  paymentShortfall,
  type CollectContext,
} from './arrearsAllocation';

const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString('en-US')}`;

/** A plan with `days` unpaid earlier days of `each`, plus today's obligation. */
function ctx(partial: Partial<CollectContext> = {}): CollectContext {
  return {
    rent_request_id: 'plan-1',
    today: '2026-09-15',
    go_live: '2026-09-10',
    expected_today: 4500,
    days_behind: 0,
    arrears_ugx: 0,
    oldest_open_day: null,
    due_today_ugx: 0,
    settled_today_ugx: 0,
    unapplied_ugx: 0,
    behind_days: [],
    behind_days_truncated: false,
    ...partial,
  };
}

const behindDay = (day: string, remaining: number) => ({
  day,
  expected: 4500,
  settled: 4500 - remaining,
  remaining,
});

describe('hasArrears', () => {
  it('is false before go-live, when the server returns an empty queue', () => {
    // This is the whole date gate: the views are floored at go-live, so every
    // arrears field is 0 until then and the UI stays exactly as it was.
    expect(hasArrears(ctx())).toBe(false);
    expect(hasArrears(null)).toBe(false);
    expect(hasArrears(undefined)).toBe(false);
  });

  it('is true once a day is behind', () => {
    expect(hasArrears(ctx({ days_behind: 1, arrears_ugx: 500 }))).toBe(true);
  });
});

describe('splitPayment', () => {
  it('settles the older unpaid days before today', () => {
    const c = ctx({
      days_behind: 1,
      arrears_ugx: 1000,
      due_today_ugx: 4500,
      behind_days: [behindDay('2026-09-14', 1000)],
    });
    const s = splitPayment(c, 4500);
    expect(s.toArrears).toBe(1000);
    expect(s.toToday).toBe(3500);
    expect(s.toFuture).toBe(0);
    expect(s.nothingLandsOnToday).toBe(false);
  });

  it('leaves today open when the older days take everything', () => {
    const c = ctx({
      days_behind: 2,
      arrears_ugx: 9000,
      due_today_ugx: 4500,
      behind_days: [behindDay('2026-09-13', 4500), behindDay('2026-09-14', 4500)],
    });
    const s = splitPayment(c, 4000);
    expect(s.toArrears).toBe(4000);
    expect(s.toToday).toBe(0);
    expect(s.nothingLandsOnToday).toBe(true);
  });

  it('pre-pays future days with the surplus', () => {
    const c = ctx({
      days_behind: 1,
      arrears_ugx: 1000,
      due_today_ugx: 4500,
      behind_days: [behindDay('2026-09-14', 1000)],
    });
    const s = splitPayment(c, 10000);
    expect(s.toArrears).toBe(1000);
    expect(s.toToday).toBe(4500);
    expect(s.toFuture).toBe(4500);
  });

  it('counts only the days the payment closes completely', () => {
    const c = ctx({
      days_behind: 3,
      arrears_ugx: 1500,
      due_today_ugx: 4500,
      behind_days: [
        behindDay('2026-09-12', 500),
        behindDay('2026-09-13', 500),
        behindDay('2026-09-14', 500),
      ],
    });
    // 700 closes the first day and part-pays the second.
    expect(splitPayment(c, 700).daysCleared).toBe(1);
    expect(splitPayment(c, 1000).daysCleared).toBe(2);
    expect(splitPayment(c, 1500).clearsAllArrears).toBe(true);
  });

  it('reports the true day count when the itemised list is truncated', () => {
    // The server caps `behind_days` for display but `arrears_ugx` and
    // `days_behind` are exact, so a payment that clears everything must not
    // report only the itemised days.
    const c = ctx({
      days_behind: 40,
      arrears_ugx: 20000,
      due_today_ugx: 500,
      behind_days_truncated: true,
      behind_days: Array.from({ length: 30 }, (_, i) =>
        behindDay(`2026-08-${String(i + 1).padStart(2, '0')}`, 500),
      ),
    });
    expect(splitPayment(c, 20000).daysCleared).toBe(40);
  });

  it('always partitions the amount — the three parts sum back exactly', () => {
    const c = ctx({
      days_behind: 2,
      arrears_ugx: 3200,
      due_today_ugx: 4500,
      behind_days: [behindDay('2026-09-13', 1700), behindDay('2026-09-14', 1500)],
    });
    for (const amount of [0, 100, 3200, 3201, 7700, 7701, 50000]) {
      const s = splitPayment(c, amount);
      expect(s.toArrears + s.toToday + s.toFuture).toBe(amount);
      expect(s.toArrears).toBeGreaterThanOrEqual(0);
      expect(s.toToday).toBeGreaterThanOrEqual(0);
      expect(s.toFuture).toBeGreaterThanOrEqual(0);
    }
  });

  it('never charges more than is owed to any bucket', () => {
    const c = ctx({ days_behind: 1, arrears_ugx: 500, due_today_ugx: 4500 });
    const s = splitPayment(c, 1000000);
    expect(s.toArrears).toBe(500);
    expect(s.toToday).toBe(4500);
  });
});

describe('copy', () => {
  it('says nothing when there are no arrears', () => {
    expect(arrearsHeadline(ctx(), ugx)).toBeNull();
    expect(splitExplanation(ctx(), 4500, ugx)).toBeNull();
  });

  it('names the days and the amount behind', () => {
    const c = ctx({ days_behind: 1, arrears_ugx: 500, due_today_ugx: 4500 });
    expect(arrearsHeadline(c, ugx)).toBe('Behind 1 day · UGX 500 unpaid');
    expect(arrearsHeadline({ ...c, days_behind: 3, arrears_ugx: 1500 }, ugx)).toBe(
      'Behind 3 days · UGX 1,500 unpaid',
    );
  });

  it('explains where the money goes', () => {
    const c = ctx({
      days_behind: 1,
      arrears_ugx: 500,
      due_today_ugx: 4500,
      behind_days: [behindDay('2026-09-14', 500)],
    });
    expect(splitExplanation(c, 4500, ugx)).toBe(
      'UGX 500 of this payment goes to the older unpaid days first. UGX 4,000 then covers today.',
    );
    expect(splitExplanation(c, 300, ugx)).toBe(
      'UGX 300 of this payment goes to the older unpaid days first. Nothing is left for today, so today stays open.',
    );
  });
});

describe('what a payment is judged against (D1)', () => {
  it('counts the earlier unpaid days as well as today', () => {
    expect(totalDueNow(ctx({ arrears_ugx: 19068, due_today_ugx: 4767 }))).toBe(23835);
    // `expected_today` is the day's bill; `due_today_ugx` is what is still open
    // on it. A day already settled owes nothing, whatever it was billed.
    expect(totalDueNow(ctx({ expected_today: 4500, due_today_ugx: 0 }))).toBe(0);
    expect(totalDueNow(null)).toBe(0);
  });

  it('calls a full day paid by a tenant five days behind a partial collection', () => {
    // The reported defect: 4,767 collected, 4 days and 19,068 still owed, and
    // the old test against today alone stamped it "not partial, no shortfall".
    const behind = ctx({ days_behind: 5, arrears_ugx: 23835, due_today_ugx: 4767 });
    expect(isPartialPayment(behind, 4767)).toBe(true);
    expect(paymentShortfall(behind, 4767)).toBe(23835);
  });

  it('is not partial when the payment clears everything owed', () => {
    const behind = ctx({ days_behind: 1, arrears_ugx: 4767, due_today_ugx: 4767 });
    expect(isPartialPayment(behind, 9534)).toBe(false);
    expect(paymentShortfall(behind, 9534)).toBe(0);
    expect(paymentShortfall(behind, 50000)).toBe(0);
  });

  it('never reports more owed than the plan outstanding', () => {
    const behind = ctx({ days_behind: 30, arrears_ugx: 143000, due_today_ugx: 0 });
    expect(paymentShortfall(behind, 0, 88000)).toBe(88000);
    expect(isPartialPayment(behind, 88000, 88000)).toBe(false);
  });

  it('stays quiet on a plan with nothing owed', () => {
    const clear = ctx({ arrears_ugx: 0, due_today_ugx: 0 });
    expect(isPartialPayment(clear, 5000)).toBe(false);
    expect(paymentShortfall(clear, 0)).toBe(0);
  });
});
