import { describe, it, expect } from 'vitest';
import { isValidNin, normalizeNin, isIdComplete } from '@/lib/welileHomesTenantId';

describe('Welile Homes tenant NIN', () => {
  it('accepts 14 characters starting with CM or CF', () => {
    expect(isValidNin('CM12345678ABCD')).toBe(true);
    expect(isValidNin('cf 1234 5678 abcd')).toBe(true);
  });
  it('rejects wrong prefix or length', () => {
    expect(isValidNin('CA12345678ABCD')).toBe(false);
    expect(isValidNin('CM12345678ABC')).toBe(false);
    expect(isValidNin('CM12345678ABCDE')).toBe(false);
  });
  it('normalizes spaces and case', () => {
    expect(normalizeNin(' cm12 34 ')).toBe('CM1234');
  });
  it('ID is complete only with both NIN and photo', () => {
    expect(isIdComplete({ nin: 'CM12345678ABCD', photo_path: '' })).toBe(false);
    expect(isIdComplete({ nin: 'CM12345678ABCD', photo_path: 'a/b/c.webp' })).toBe(true);
    expect(isIdComplete(null)).toBe(false);
  });
});
