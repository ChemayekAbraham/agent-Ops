import { describe, expect, it } from 'vitest';
import { rdProjectCashValue } from '../lib/rdProjectCash';

describe('R&D project cash metrics', () => {
  const rows = [{ id: 'car', customers: 19, cashIn: 21000000, cashOut: 38240000 }];
  it('shows full exact amounts from the cash position', () => {
    expect(rdProjectCashValue(rows, 'car', 'cashIn')).toBe('UGX\u00a021,000,000');
    expect(rdProjectCashValue(rows, 'car', 'cashOut')).toBe('UGX\u00a038,240,000');
    expect(rdProjectCashValue(rows, 'car', 'customers')).toBe('19');
  });
  it('follows edits without restoring old figures for missing rows', () => {
    expect(rdProjectCashValue([{ ...rows[0], cashIn: 470000 }], 'car', 'cashIn')).toBe('UGX\u00a0470,000');
    expect(rdProjectCashValue([], 'car', 'cashIn')).toBe('—');
  });
});