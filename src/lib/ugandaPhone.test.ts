import { describe, it, expect } from 'vitest';
import { toUgandaE164, validateUgandaPhone, isValidUgandaPhone, ugandaPhoneSchema } from './ugandaPhone';

describe('toUgandaE164', () => {
  it('normalises local 0-prefixed numbers', () => {
    expect(toUgandaE164('0759229748')).toBe('256759229748');
    expect(toUgandaE164('0759 229 748')).toBe('256759229748');
  });
  it('normalises bare 9-digit numbers', () => {
    expect(toUgandaE164('759229748')).toBe('256759229748');
  });
  it('keeps already-international numbers', () => {
    expect(toUgandaE164('256759229748')).toBe('256759229748');
    expect(toUgandaE164('+256 759 229 748')).toBe('256759229748');
  });
  it('rejects invalid numbers', () => {
    expect(toUgandaE164('')).toBeNull();
    expect(toUgandaE164(null)).toBeNull();
    expect(toUgandaE164('12345')).toBeNull();
    expect(toUgandaE164('0259229748')).toBeNull(); // 2nd digit < 3
    expect(toUgandaE164('07592297')).toBeNull(); // too short
    expect(toUgandaE164('075922974899')).toBeNull(); // too long
  });
});

describe('validateUgandaPhone', () => {
  it('returns e164 for valid numbers', () => {
    expect(validateUgandaPhone('0759229748')).toEqual({ valid: true, e164: '256759229748' });
  });
  it('reports a required error for empty input', () => {
    expect(validateUgandaPhone('')).toMatchObject({ valid: false, error: 'Phone number is required' });
  });
  it('reports an invalid error for bad input', () => {
    expect(validateUgandaPhone('abc')).toMatchObject({ valid: false });
  });
});

describe('isValidUgandaPhone', () => {
  it('is true only for dialable numbers', () => {
    expect(isValidUgandaPhone('0759229748')).toBe(true);
    expect(isValidUgandaPhone('123')).toBe(false);
  });
});

describe('ugandaPhoneSchema', () => {
  it('parses and transforms to e164', () => {
    expect(ugandaPhoneSchema.parse('0759229748')).toBe('256759229748');
  });
  it('fails on invalid', () => {
    expect(ugandaPhoneSchema.safeParse('xx').success).toBe(false);
  });
});