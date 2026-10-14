import { describe, expect, it } from 'vitest';
import { rdWeeklyUpdates, rdDateOffset } from '@/lib/rdWeeklyUpdates';

const updates = ['2026-10-06', '2026-10-07', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-21', '2026-10-22']
  .map((date) => ({ id: date, date, text: `Recorded ${date}` }));

describe('recorded weekly R&D updates', () => {
  it('uses only the preceding seven dates for last seven days, excluding today', () => {
    expect(rdWeeklyUpdates(updates, 'last', '2026-10-14').map((u) => u.date)).toEqual(['2026-10-07', '2026-10-13']);
  });
  it('uses only the report date for today', () => {
    expect(rdWeeklyUpdates(updates, 'today', '2026-10-14').map((u) => u.date)).toEqual(['2026-10-14']);
  });
  it('uses only recorded future entries for the following seven days', () => {
    expect(rdWeeklyUpdates(updates, 'next', '2026-10-14').map((u) => u.date)).toEqual(['2026-10-15', '2026-10-21']);
    expect(rdWeeklyUpdates([], 'next', '2026-10-14')).toEqual([]);
  });
  it('reflects edits to the source update rather than keeping a report copy', () => {
    const edited = updates.map((u) => u.date === '2026-10-14' ? { ...u, text: 'Actual saved update' } : u);
    expect(rdWeeklyUpdates(edited, 'today', '2026-10-14')[0]?.text).toBe('Actual saved update');
  });
  it('handles month and year boundaries', () => {
    expect(rdDateOffset('2026-01-01', -1)).toBe('2025-12-31');
    expect(rdDateOffset('2026-10-31', 1)).toBe('2026-11-01');
  });
});