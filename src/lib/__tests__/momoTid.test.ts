import { describe, it, expect } from 'vitest';
import { normalizeMomoTid, momoTidsMatch } from '../momoTid';

describe('normalizeMomoTid', () => {
  it('strips MTN "MP" prefix', () => {
    expect(normalizeMomoTid('MP40781351736')).toBe('40781351736');
  });

  it('strips Airtel "AT" prefix', () => {
    expect(normalizeMomoTid('AT40781351736')).toBe('40781351736');
  });

  it('strips lowercase + mixed-case prefixes', () => {
    expect(normalizeMomoTid('mp40781351736')).toBe('40781351736');
    expect(normalizeMomoTid('Mp40781351736')).toBe('40781351736');
  });

  it('strips embedded spaces, dashes and dots', () => {
    expect(normalizeMomoTid('MP 4078 1351-736')).toBe('40781351736');
    expect(normalizeMomoTid('MP.40781351736')).toBe('40781351736');
  });

  it('leaves a clean numeric TID untouched', () => {
    expect(normalizeMomoTid('40781351736')).toBe('40781351736');
  });

  it('returns empty string for null/undefined/empty', () => {
    expect(normalizeMomoTid(null)).toBe('');
    expect(normalizeMomoTid(undefined)).toBe('');
    expect(normalizeMomoTid('')).toBe('');
  });

  it('returns empty when no digits are present', () => {
    expect(normalizeMomoTid('MP-NA')).toBe('');
  });
});

describe('momoTidsMatch (carrier prefix collapse)', () => {
  it('matches MTN-prefixed in-app entry against raw email receipt', () => {
    expect(momoTidsMatch('MP40781351736', '40781351736')).toBe(true);
  });

  it('matches Airtel-prefixed in-app entry against raw email receipt', () => {
    expect(momoTidsMatch('AT40781351736', '40781351736')).toBe(true);
  });

  it('matches across two different carrier prefixes for the same digits', () => {
    expect(momoTidsMatch('MP40781351736', 'AT40781351736')).toBe(true);
  });

  it('rejects different digit tails even with same prefix', () => {
    expect(momoTidsMatch('MP40781351736', 'MP40781351737')).toBe(false);
  });

  it('rejects when one side is empty', () => {
    expect(momoTidsMatch('', 'MP40781351736')).toBe(false);
    expect(momoTidsMatch('MP40781351736', null)).toBe(false);
  });
});