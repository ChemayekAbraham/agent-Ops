import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), channel: vi.fn(), removeChannel: vi.fn() } }));

import { daysIntoRuleWeek } from '@/hooks/useAgentCapacityMap';

// Judged week 15 Oct (Thu) -> current rule week 22 Oct (Thu) .. 28 Oct (Wed). Times are UTC;
// Kampala is UTC+3, so 21:00 UTC is already the next Kampala day.
describe('daysIntoRuleWeek', () => {
  it('counts Thursday as day 1 and Wednesday as day 7 (Kampala dates)', () => {
    expect(daysIntoRuleWeek('2026-10-15', new Date('2026-10-22T06:00:00Z'))).toBe(1);
    expect(daysIntoRuleWeek('2026-10-15', new Date('2026-10-27T09:00:00Z'))).toBe(6);
    expect(daysIntoRuleWeek('2026-10-15', new Date('2026-10-28T20:00:00Z'))).toBe(7);
  });
  it('uses the Kampala day, not the UTC day', () => {
    // 21:30 UTC on Wed 21 Oct is 00:30 Thu 22 Oct in Kampala: day 1 of the new week.
    expect(daysIntoRuleWeek('2026-10-15', new Date('2026-10-21T21:30:00Z'))).toBe(1);
  });
  it('stays within 1..7 if the judged week is stale or ahead', () => {
    expect(daysIntoRuleWeek('2026-10-15', new Date('2026-11-05T09:00:00Z'))).toBe(7);
    expect(daysIntoRuleWeek('2026-10-22', new Date('2026-10-27T09:00:00Z'))).toBe(1);
  });
});
