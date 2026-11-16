import { describe, expect, it } from 'vitest';
import { houseIntegerFilter } from './houseIntegerFilter';

describe('house integer filters', () => {
  it('sends a whole-number minimum for the reported 1.3 rooms filter', () => {
    expect(houseIntegerFilter(1.3, 'min')).toBe(2);
  });
  it('rounds maximum integer rates down and minimum rates up', () => {
    expect(houseIntegerFilter(1234.5, 'max')).toBe(1234);
    expect(houseIntegerFilter(1234.5, 'min')).toBe(1235);
  });
  it('omits non-finite or unset bounds rather than sending invalid input', () => {
    for (const value of [undefined, NaN, Infinity, -1, 0]) {
      expect(houseIntegerFilter(value, 'min')).toBeUndefined();
    }
  });
});