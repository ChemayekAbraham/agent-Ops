import { describe, it, expect } from 'vitest';
import {
  joinPersonName,
  splitPersonName,
  validatePersonNameParts,
} from '@/lib/authValidation';

describe('joinPersonName', () => {
  it('joins first + last', () => {
    expect(joinPersonName({ firstName: 'Alice', otherNames: '', lastName: 'Nakato' })).toBe('Alice Nakato');
  });
  it('joins first + other + last', () => {
    expect(joinPersonName({ firstName: 'Alice', otherNames: 'Grace', lastName: 'Nakato' })).toBe('Alice Grace Nakato');
  });
  it('supports multi-token other names', () => {
    expect(joinPersonName({ firstName: 'Alice', otherNames: 'Grace Mary', lastName: 'Nakato' })).toBe('Alice Grace Mary Nakato');
  });
  it('drops whitespace-only parts', () => {
    expect(joinPersonName({ firstName: ' Alice ', otherNames: '   ', lastName: ' Nakato ' })).toBe('Alice Nakato');
  });
  it('collapses internal double spaces', () => {
    expect(joinPersonName({ firstName: 'Alice', otherNames: 'Grace   Mary', lastName: 'Nakato' })).toBe('Alice Grace Mary Nakato');
  });
  it('returns empty string when all parts empty', () => {
    expect(joinPersonName({ firstName: '', otherNames: '', lastName: '' })).toBe('');
  });
  it('tolerates missing keys', () => {
    expect(joinPersonName({ firstName: 'Alice' })).toBe('Alice');
    expect(joinPersonName({})).toBe('');
  });
});

describe('splitPersonName', () => {
  it('handles null / undefined / empty', () => {
    const empty = { firstName: '', otherNames: '', lastName: '' };
    expect(splitPersonName(null)).toEqual(empty);
    expect(splitPersonName(undefined)).toEqual(empty);
    expect(splitPersonName('')).toEqual(empty);
    expect(splitPersonName('    ')).toEqual(empty);
  });
  it('splits 1 token', () => {
    expect(splitPersonName('Alice')).toEqual({ firstName: 'Alice', otherNames: '', lastName: '' });
  });
  it('splits 2 tokens', () => {
    expect(splitPersonName('Alice Nakato')).toEqual({ firstName: 'Alice', otherNames: '', lastName: 'Nakato' });
  });
  it('splits 3 tokens', () => {
    expect(splitPersonName('Alice Grace Nakato')).toEqual({ firstName: 'Alice', otherNames: 'Grace', lastName: 'Nakato' });
  });
  it('splits 4 tokens', () => {
    expect(splitPersonName('Alice Grace Mary Nakato')).toEqual({ firstName: 'Alice', otherNames: 'Grace Mary', lastName: 'Nakato' });
  });
  it('splits 5 tokens', () => {
    expect(splitPersonName('Alice Grace Mary Jane Nakato')).toEqual({ firstName: 'Alice', otherNames: 'Grace Mary Jane', lastName: 'Nakato' });
  });
  it('collapses leading/trailing/internal whitespace', () => {
    expect(splitPersonName('  Alice   Grace   Nakato  ')).toEqual({ firstName: 'Alice', otherNames: 'Grace', lastName: 'Nakato' });
    expect(splitPersonName('Alice\tGrace\nNakato')).toEqual({ firstName: 'Alice', otherNames: 'Grace', lastName: 'Nakato' });
  });
});

describe('round trip', () => {
  it.each(['Alice Nakato', 'Alice Grace Nakato', '  Alice   Grace   Nakato ', 'Alice Grace Mary Nakato'])(
    'join(split(%s)) equals normalised input',
    (raw) => {
      expect(joinPersonName(splitPersonName(raw))).toBe(raw.trim().replace(/\s+/g, ' '));
    },
  );
});

describe('validatePersonNameParts', () => {
  it('accepts a valid first + last', () => {
    const r = validatePersonNameParts({ firstName: 'Alice', otherNames: '', lastName: 'Nakato' });
    expect(r.valid).toBe(true);
    expect(r.fullName).toBe('Alice Nakato');
    expect(r.error).toBeNull();
  });
  it('accepts first + other + last', () => {
    const r = validatePersonNameParts({ firstName: 'Alice', otherNames: 'Grace', lastName: 'Nakato' });
    expect(r.valid).toBe(true);
    expect(r.fullName).toBe('Alice Grace Nakato');
  });
  it('rejects a missing first name', () => {
    const r = validatePersonNameParts({ firstName: '', otherNames: '', lastName: 'Nakato' });
    expect(r.valid).toBe(false);
    expect(r.error).toBe('First name is required');
  });
  it('rejects a whitespace-only first name', () => {
    expect(validatePersonNameParts({ firstName: '   ', otherNames: '', lastName: 'Nakato' }).error).toBe('First name is required');
  });
  it('rejects a missing last name', () => {
    const r = validatePersonNameParts({ firstName: 'Alice', otherNames: '', lastName: '' });
    expect(r.valid).toBe(false);
    expect(r.error).toBe('Last name is required');
  });
  it('rejects a whitespace-only last name', () => {
    expect(validatePersonNameParts({ firstName: 'Alice', otherNames: '', lastName: '  ' }).error).toBe('Last name is required');
  });
  it('still rejects junk names via validateFullName', () => {
    const r = validatePersonNameParts({ firstName: 'aa', otherNames: '', lastName: 'bb' });
    expect(r.valid).toBe(false);
    expect(r.error).toBeTruthy();
  });
  it('still rejects identical first and last via validateFullName', () => {
    const r = validatePersonNameParts({ firstName: 'John', otherNames: '', lastName: 'John' });
    expect(r.valid).toBe(false);
    expect(r.error).toBeTruthy();
  });
});