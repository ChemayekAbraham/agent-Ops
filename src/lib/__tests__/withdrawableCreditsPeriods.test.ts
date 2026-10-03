import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { periodBounds } from '@/components/cfo/WithdrawableCreditsLivePanel';

/**
 * Period boundaries must be Kampala (EAT, UTC+3) calendar days so the card's
 * buckets match the CFO reporting RPCs regardless of the viewer's timezone.
 * Frozen clock: 2026-10-03 07:00 UTC = 10:00 Kampala.
 */
const NOW = Date.UTC(2026, 9, 3, 7, 0, 0);

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe('periodBounds (Kampala day buckets)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('today starts at Kampala midnight and has no upper bound', () => {
    const b = periodBounds('today');
    expect(iso(b.from)).toBe('2026-10-02T21:00:00.000Z');
    expect(b.to).toBeNull();
    expect(b.phrase).toContain('since midnight');
  });

  it('yesterday is one full Kampala day, ending at today’s midnight', () => {
    const b = periodBounds('yesterday');
    expect(iso(b.from)).toBe('2026-10-01T21:00:00.000Z');
    expect(iso(b.to)).toBe('2026-10-02T21:00:00.000Z');
    expect(b.phrase).toContain('Fri 02 Oct');
  });

  it('past 7 days spans six full days back to today, open-ended', () => {
    const b = periodBounds('sevenDays');
    expect(iso(b.from)).toBe('2026-09-26T21:00:00.000Z');
    expect(b.to).toBeNull();
    expect(b.phrase).toContain('past 7 days');
  });

  it('this month starts at the 1st of the Kampala month', () => {
    const b = periodBounds('month');
    expect(iso(b.from)).toBe('2026-09-30T21:00:00.000Z');
    expect(b.to).toBeNull();
    expect(b.phrase).toContain('this month');
  });

  it('is timezone-independent: late UTC night rolls to the next Kampala day', () => {
    // 23:30 UTC on 3 Oct is already 02:30 on 4 Oct in Kampala, so "today"
    // must start at Kampala midnight of the 4th (2026-10-03T21:00Z).
    vi.setSystemTime(Date.UTC(2026, 9, 3, 23, 30, 0));
    const b = periodBounds('today');
    expect(iso(b.from)).toBe('2026-10-03T21:00:00.000Z');
  });
});
