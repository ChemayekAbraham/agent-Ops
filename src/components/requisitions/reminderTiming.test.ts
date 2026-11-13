import { describe, expect, it } from 'vitest';
import { REQUISITION_REMINDER_MS, reminderDelay, reminderDue } from './reminderTiming';

describe('four-hour requisition notifications', () => {
  it('waits exactly four hours between checks, not five minutes', () => {
    expect(REQUISITION_REMINDER_MS).toBe(14_400_000);
    const checked = Date.parse('2026-11-13T07:02:00Z');
    expect(reminderDue(null, checked)).toBe(true);
    expect(reminderDue(checked, checked + 300_000)).toBe(false);
    expect(reminderDue(checked, checked + 14_399_999)).toBe(false);
    expect(reminderDue(checked, checked + 14_400_000)).toBe(true);
  });

  it('never accepts a five-minute or invalid snooze in place of four hours', () => {
    const now = Date.parse('2026-11-13T07:02:00Z');
    expect(reminderDelay('2026-11-13T07:07:00Z', now)).toBe(14_400_000);
    expect(reminderDelay('2026-11-13T11:02:00Z', now)).toBe(14_400_000);
    expect(reminderDelay(null, now)).toBe(14_400_000);
  });
});