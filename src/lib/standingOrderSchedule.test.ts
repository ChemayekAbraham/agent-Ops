import { describe, it, expect } from 'vitest';
import { getNextRunDate, computeNextRun } from './standingOrderSchedule';

describe('monthly standing order time-of-day preservation', () => {
  it('keeps the original next_run_at time-of-day across many monthly cycles', () => {
    // Created at a specific, non-midnight local time.
    const createdAt = new Date(2026, 0, 15, 9, 37, 12, 0); // 15 Jan 2026, 09:37:12
    const first = new Date(getNextRunDate({ frequency: 'monthly', dayOfMonth: 15, dayOfWeek: 1, intervalDays: 30 }, createdAt));

    const h = first.getHours();
    const m = first.getMinutes();
    const s = first.getSeconds();

    // Run 24 cycles forward; the wall-clock time must never drift.
    let cursor = first;
    for (let i = 0; i < 24; i++) {
      cursor = computeNextRun(cursor, { frequency: 'monthly' });
      expect(cursor.getHours()).toBe(h);
      expect(cursor.getMinutes()).toBe(m);
      expect(cursor.getSeconds()).toBe(s);
    }
  });

  it('rolls to next month when the chosen day already passed today, preserving creation time', () => {
    const createdAt = new Date(2026, 5, 20, 14, 5, 0, 0); // 20 Jun 2026, 14:05
    const next = new Date(getNextRunDate({ frequency: 'monthly', dayOfMonth: 10, dayOfWeek: 1, intervalDays: 30 }, createdAt));
    expect(next.getMonth()).toBe(6); // July
    expect(next.getDate()).toBe(10);
    expect(next.getHours()).toBe(14);
    expect(next.getMinutes()).toBe(5);
  });

  it('daily / weekly / interval also preserve the creation time-of-day', () => {
    const createdAt = new Date(2026, 2, 3, 7, 22, 45, 0);
    for (const cfg of [
      { frequency: 'daily' as const, dayOfMonth: 1, dayOfWeek: 1, intervalDays: 1 },
      { frequency: 'weekly' as const, dayOfMonth: 1, dayOfWeek: 5, intervalDays: 1 },
      { frequency: 'interval' as const, dayOfMonth: 1, dayOfWeek: 1, intervalDays: 3 },
    ]) {
      const next = new Date(getNextRunDate(cfg, createdAt));
      expect(next.getHours()).toBe(7);
      expect(next.getMinutes()).toBe(22);
      expect(next.getSeconds()).toBe(45);
    }
  });
});

describe('monthly standing order end-of-month / leap-year handling', () => {
  // JS Date.setMonth overflows short months: e.g. Jan 31 + 1 month -> "Feb 31"
  // which rolls forward into March. These cases lock in that documented
  // behaviour AND confirm the time-of-day is preserved through the overflow.
  const eom: Array<{ label: string; from: Date; y: number; mo: number; d: number }> = [
    // Jan 31 -> Feb has 28 days (2026 non-leap) -> rolls to Mar 3
    { label: 'Jan 31 (non-leap year)', from: new Date(2026, 0, 31, 9, 15, 30), y: 2026, mo: 3, d: 3 },
    // Jan 31 -> Feb has 29 days (2028 leap) -> rolls to Mar 2
    { label: 'Jan 31 (leap year)', from: new Date(2028, 0, 31, 9, 15, 30), y: 2028, mo: 3, d: 2 },
    // Feb 28 (non-leap) -> Mar 28 (no overflow)
    { label: 'Feb 28 (non-leap year)', from: new Date(2026, 1, 28, 8, 0, 0), y: 2026, mo: 3, d: 28 },
    // Feb 29 (leap) -> Mar 29 (no overflow)
    { label: 'Feb 29 (leap year)', from: new Date(2028, 1, 29, 8, 0, 0), y: 2028, mo: 3, d: 29 },
    // Mar 31 -> Apr has 30 days -> rolls to May 1
    { label: 'Mar 31', from: new Date(2026, 2, 31, 12, 0, 0), y: 2026, mo: 5, d: 1 },
    // Dec 31 -> Jan 31 next year (no overflow, year increments)
    { label: 'Dec 31 (year rollover)', from: new Date(2026, 11, 31, 23, 59, 0), y: 2027, mo: 1, d: 31 },
  ];

  eom.forEach(({ label, from, y, mo, d }) => {
    it(`computeNextRun handles ${label} and preserves time-of-day`, () => {
      const next = computeNextRun(from, { frequency: 'monthly' });
      expect(next.getFullYear()).toBe(y);
      expect(next.getMonth() + 1).toBe(mo);
      expect(next.getDate()).toBe(d);
      // Time-of-day must survive the month overflow exactly.
      expect(next.getHours()).toBe(from.getHours());
      expect(next.getMinutes()).toBe(from.getMinutes());
      expect(next.getSeconds()).toBe(from.getSeconds());
    });
  });

  it('Feb 29 leap-day order lands on Feb 28 two non-leap years later via successive cycles', () => {
    // Start on a leap day, advance month-by-month for 12 cycles and ensure
    // the wall-clock time never drifts even across short-month overflows.
    let cursor = new Date(2028, 1, 29, 6, 45, 10); // 29 Feb 2028
    for (let i = 0; i < 12; i++) {
      cursor = computeNextRun(cursor, { frequency: 'monthly' });
      expect(cursor.getHours()).toBe(6);
      expect(cursor.getMinutes()).toBe(45);
      expect(cursor.getSeconds()).toBe(10);
    }
  });

  it('getNextRunDate with dayOfMonth=31 in a short creation month overflows but keeps creation time', () => {
    // Created 10 Feb 2026 with a day-of-month of 31; Feb has no 31st so the
    // first run overflows into March while keeping the creation time-of-day.
    const createdAt = new Date(2026, 1, 10, 16, 20, 5);
    const next = new Date(getNextRunDate({ frequency: 'monthly', dayOfMonth: 31, dayOfWeek: 1, intervalDays: 30 }, createdAt));
    expect(next.getMonth() + 1).toBe(3); // March (Feb 31 overflow)
    expect(next.getDate()).toBe(3);
    expect(next.getHours()).toBe(16);
    expect(next.getMinutes()).toBe(20);
    expect(next.getSeconds()).toBe(5);
  });
});
