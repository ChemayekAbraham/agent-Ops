import { describe, expect, it } from 'vitest';
import {
  maskMoney,
  maskSensitiveValue,
  shoppingAdvanceAccessLimit,
} from './shoppingAdvanceDossier';

describe('Shopping Advance dossier helpers', () => {
  it('calculates informational access without exceeding the cap', () => {
    expect(shoppingAdvanceAccessLimit(0)).toBe(30_000);
    expect(shoppingAdvanceAccessLimit(10_000)).toBe(50_000);
    expect(shoppingAdvanceAccessLimit(20_000_000)).toBe(30_000_000);
  });

  it('does not reduce access below the base for invalid totals', () => {
    expect(shoppingAdvanceAccessLimit(-5_000)).toBe(30_000);
    expect(shoppingAdvanceAccessLimit(Number.NaN)).toBe(30_000);
  });

  it('masks contacts and monetary values until revealed', () => {
    expect(maskSensitiveValue('+256700123456')).toBe('+2••••456');
    expect(maskSensitiveValue('jane@example.com')).toBe('ja•••@example.com');
    expect(maskMoney(false, 'UGX 50,000')).toBe('UGX ••••••');
    expect(maskMoney(true, 'UGX 50,000')).toBe('UGX 50,000');
  });
});
