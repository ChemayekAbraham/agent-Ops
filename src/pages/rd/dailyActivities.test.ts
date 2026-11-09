import { describe, expect, it } from 'vitest';
import { draftWeeklyReport, weekStart } from './dailyActivities';

describe('R&D daily activities', () => {
  it('weeks run Monday to Sunday', () => {
    expect(weekStart('2026-11-09')).toBe('2026-11-09');
    expect(weekStart('2026-11-15')).toBe('2026-11-09');
    expect(weekStart('2026-11-16')).toBe('2026-11-16');
  });

  it('weekly draft includes only that week\'s activities', () => {
    const draft = draftWeeklyReport([
      { id: '1', date: '2026-11-10', project: 'Welile Car', text: 'Tested prototype', createdAt: 'a' },
      { id: '2', date: '2026-11-17', project: '', text: 'Next week item', createdAt: 'b' },
    ], '2026-11-09');
    expect(draft).toContain('[Welile Car] Tested prototype');
    expect(draft).not.toContain('Next week item');
    expect(draft).toContain('1 activity recorded on 1 day(s)');
  });
});
