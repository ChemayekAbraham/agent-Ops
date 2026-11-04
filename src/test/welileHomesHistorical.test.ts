import { describe, it, expect, vi } from 'vitest';
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
import { validateWhEntry, breakdown, buildWhCsv, kampalaToday } from '@/lib/welileHomesHistorical';

const base = { amount: 500000, paidOn: '2026-10-01', reference: 'MP123', channel: 'mtn_momo', agentId: 'a', subscriptionId: 's' };

describe('Welile Homes historical disbursements', () => {
  it('rejects zero or negative amounts', () => {
    expect(validateWhEntry({ ...base, amount: 0 })).toBe('Amount must be greater than zero');
    expect(validateWhEntry({ ...base, amount: -5 })).toBe('Amount must be greater than zero');
  });
  it('rejects a future date', () => {
    expect(validateWhEntry({ ...base, paidOn: '2999-01-01' })).toBe('Date paid cannot be in the future');
    expect(validateWhEntry({ ...base, paidOn: kampalaToday() })).toBeNull();
  });
  it('reversed manual entries never count in totals', () => {
    const rows = breakdown([], [
      { amount: 100, channel: 'cash', reversed: false } as any,
      { amount: 900, channel: 'cash', reversed: true } as any,
    ], () => 'k');
    expect(rows[0].manual).toBe(100);
  });
  it('keeps system and manual amounts in separate columns', () => {
    const rows = breakdown([{ amount: 300, channel: 'in_app' } as any], [{ amount: 100, reversed: false } as any], () => 'k');
    expect(rows[0]).toMatchObject({ system: 300, manual: 100 });
  });
  it('CSV labels each row as system recorded or manually entered', () => {
    const csv = buildWhCsv([{ amount: 1, channel: 'in_app', paid_on: '2026-01-01' } as any], [{ amount: 2, channel: 'cash', paid_on: '2026-01-02', reversed: false } as any]);
    expect(csv).toContain('System recorded');
    expect(csv).toContain('Manually entered - historical');
  });
});
