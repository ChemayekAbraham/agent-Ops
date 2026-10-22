import { describe, expect, it } from 'vitest';
import { rdWeeklyUpdates, rdDateOffset, rdReportUpdatesForPeriod, rdPeriodRange, rdNewUpdateDate } from '@/lib/rdWeeklyUpdates';

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

describe('report period filter', () => {
  it('keeps every recorded update when the whole record is chosen', () => {
    expect(rdReportUpdatesForPeriod(updates, 'all', '2026-10-14')).toHaveLength(7);
  });
  it('limits the report to the last seven days or the next seven days', () => {
    expect(rdReportUpdatesForPeriod(updates, 'last', '2026-10-14').map((u) => u.date)).toEqual(['2026-10-07', '2026-10-13']);
    expect(rdReportUpdatesForPeriod(updates, 'next', '2026-10-14').map((u) => u.date)).toEqual(['2026-10-15', '2026-10-21']);
  });
  it('limits the report to the report date only for today', () => {
    expect(rdReportUpdatesForPeriod(updates, 'today', '2026-10-14').map((u) => u.date)).toEqual(['2026-10-14']);
  });
});

describe('report period range and new-update date', () => {
  it('gives the exact calendar window of each period', () => {
    expect(rdPeriodRange('last', '2026-10-14')).toEqual({ start: '2026-10-07', end: '2026-10-13' });
    expect(rdPeriodRange('today', '2026-10-14')).toEqual({ start: '2026-10-14', end: '2026-10-14' });
    expect(rdPeriodRange('next', '2026-10-14')).toEqual({ start: '2026-10-15', end: '2026-10-21' });
    expect(rdPeriodRange('all', '2026-10-14')).toBeNull();
  });
  it('dates a newly recorded update inside the chosen period', () => {
    expect(rdNewUpdateDate('next', '2026-10-14')).toBe('2026-10-15');
    expect(rdNewUpdateDate('last', '2026-10-14')).toBe('2026-10-07');
    expect(rdNewUpdateDate('today', '2026-10-14')).toBe('2026-10-14');
    expect(rdNewUpdateDate('all', '2026-10-14')).toBe('2026-10-14');
  });
});