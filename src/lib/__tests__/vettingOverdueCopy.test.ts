import { describe, it, expect } from 'vitest';
import { buildOverdueDialogCopy, buildDueSoonBanner, formatAge, type OverdueVetting } from '@/lib/vettingOverdueCopy';

const base: OverdueVetting = {
  enabled: true, overdue_hours: 48, warn_hours: 36, remind_after_seconds: 60,
  overdue_count: 5, due_soon_count: 0, escalated_count: 0, oldest_age_hours: 52,
  by_kind: { rent_plan: 3, landlord: 1, lc1: 1 }, oldest: [],
};

describe('vettingOverdueCopy', () => {
  it('formats ages', () => {
    expect(formatAge(5)).toBe('5h');
    expect(formatAge(100)).toBe('4d 4h');
  });

  it('lists the breakdown for several items', () => {
    const c = buildOverdueDialogCopy(base);
    expect(c.title).toBe('Vetting overdue');
    expect(c.body).toContain('5 items');
    expect(c.body).toContain('3 Rent Plans, 1 Landlord, 1 LC1 chairperson');
    expect(c.body).toContain('2d 4h');
  });

  it('names the single item', () => {
    const c = buildOverdueDialogCopy({
      ...base, overdue_count: 1, by_kind: { rent_plan: 1, landlord: 0, lc1: 0 },
      oldest: [{ kind: 'rent_plan', id: 'x', label: 'Amina', age_hours: 52 }],
    });
    expect(c.body).toContain('One Rent Plan for Amina');
  });

  it('escalates past 1.5x the limit', () => {
    const c = buildOverdueDialogCopy({ ...base, escalated_count: 2 });
    expect(c.tone).toBe('escalated');
    expect(c.title).toBe('Escalated to Agent Ops');
    expect(c.body).toContain('72 hours');
  });

  it('never uses forbidden terms or emojis', () => {
    const text = JSON.stringify([buildOverdueDialogCopy(base), buildOverdueDialogCopy({ ...base, escalated_count: 1 })]);
    expect(text).not.toMatch(/loan|lender|\bROI\b|interest/i);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('banner only when something is due soon', () => {
    expect(buildDueSoonBanner(base)).toBeNull();
    expect(buildDueSoonBanner({ ...base, due_soon_count: 4 })).toContain('4 items will pass the 48-hour limit');
  });
});

describe('vettingClockAt', () => {
  it('uses the later of creation and go-live', async () => {
    const { vettingClockAt } = await import('@/lib/vettingOverdueCopy');
    expect(vettingClockAt('2026-09-01T00:00:00Z', '2026-10-08T00:00:00Z')).toBe('2026-10-08T00:00:00.000Z');
    expect(vettingClockAt('2026-10-09T00:00:00Z', '2026-10-08T00:00:00Z')).toBe('2026-10-09T00:00:00.000Z');
    expect(vettingClockAt('2026-09-01T00:00:00Z', null)).toBe('2026-09-01T00:00:00Z');
    expect(vettingClockAt(null, '2026-10-08T00:00:00Z')).toBeNull();
  });
});
