import { describe, it, expect } from 'vitest';
import {
  formatUgandaPhone,
  normalizeE164OrNull,
  isValidPhoneNumber,
  isValidPhoneNumberGlobal,
  parsePhoneNumber,
} from './phoneUtils';

describe('formatUgandaPhone', () => {
  it('formats local Uganda numbers', () => {
    expect(formatUgandaPhone('0721234567')).toBe('0721 234 567');
    expect(formatUgandaPhone('0791234567')).toBe('0791 234 567');
    expect(formatUgandaPhone('079 1234 567')).toBe('0791 234 567');
  });

  it('formats Uganda international numbers', () => {
    expect(formatUgandaPhone('+256721234567')).toBe('+256 721 234 567');
    expect(formatUgandaPhone('+25672')).toBe('+256 72');
    expect(formatUgandaPhone('256721234567')).toBe('256 721 234 567');
  });

  it('formats non-Uganda international numbers without forcing +256', () => {
    expect(formatUgandaPhone('+25779123456')).toBe('+257 791 234 56');
    expect(formatUgandaPhone('+25779')).toBe('+257 79');
    expect(formatUgandaPhone('+254712345678')).toBe('+254 712 345 678');
  });

  it('returns empty string for empty input', () => {
    expect(formatUgandaPhone('')).toBe('');
    expect(formatUgandaPhone('   ')).toBe('');
  });

  it('returns "+" for a bare plus sign', () => {
    expect(formatUgandaPhone('+')).toBe('+');
  });
});

describe('normalizeE164OrNull', () => {
  it('normalizes Uganda numbers', () => {
    expect(normalizeE164OrNull('0721234567')).toBe('+256721234567');
    expect(normalizeE164OrNull('+256721234567')).toBe('+256721234567');
    expect(normalizeE164OrNull('256721234567')).toBe('+256721234567');
    expect(normalizeE164OrNull('721234567')).toBe('+256721234567');
  });

  it('normalizes explicit international numbers', () => {
    expect(normalizeE164OrNull('+25779123456')).toBe('+25779123456');
    expect(normalizeE164OrNull('+254712345678')).toBe('+254712345678');
  });

  it('returns null for incomplete numbers', () => {
    expect(normalizeE164OrNull('+25779')).toBeNull();
    expect(normalizeE164OrNull('+25672')).toBeNull();
    expect(normalizeE164OrNull('072')).toBeNull();
  });
});

describe('isValidPhoneNumber', () => {
  it('accepts full numbers', () => {
    expect(isValidPhoneNumber('0721234567')).toBe(true);
    expect(isValidPhoneNumber('+256721234567')).toBe(true);
    expect(isValidPhoneNumber('+25779123456')).toBe(true);
  });

  it('rejects incomplete numbers', () => {
    expect(isValidPhoneNumber('+25779')).toBe(false);
    expect(isValidPhoneNumber('072')).toBe(false);
    expect(isValidPhoneNumber('+25672')).toBe(false);
  });
});

describe('isValidPhoneNumberGlobal', () => {
  it('accepts full non-sequential numbers', () => {
    expect(isValidPhoneNumberGlobal('+256791837465').valid).toBe(true);
    expect(isValidPhoneNumberGlobal('+25779183746').valid).toBe(true);
  });

  it('rejects repeated or sequential digits', () => {
    expect(isValidPhoneNumberGlobal('0721111111').valid).toBe(false);
    expect(isValidPhoneNumberGlobal('0721234567').valid).toBe(false);
  });
});

describe('parsePhoneNumber', () => {
  it('detects Uganda country', () => {
    const info = parsePhoneNumber('+256721234567');
    expect(info.countryCode).toBe('256');
    expect(info.isUgandan).toBe(true);
  });

  it('detects Burundi country', () => {
    const info = parsePhoneNumber('+25779123456');
    expect(info.countryCode).toBe('257');
    expect(info.isUgandan).toBe(false);
  });
});
