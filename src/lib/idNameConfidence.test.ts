import { describe, expect, it } from 'vitest';
import { assessIdNameConfidence } from '@/lib/idNameConfidence';

describe('assessIdNameConfidence', () => {
  it('flags a garbled card-label fusion instead of trusting it as a real name (regression: Lukyamuzi Derrick)', () => {
    const result = assessIdNameConfidence('STHERNAME DERRICK');
    expect(result.confident).toBe(false);
    expect(result.reason).toMatch(/garbled|card itself/i);
  });

  it('flags exact card-label words', () => {
    expect(assessIdNameConfidence('SURNAME DERRICK').confident).toBe(false);
    expect(assessIdNameConfidence('GIVEN NAMES').confident).toBe(false);
  });

  it('trusts real Ugandan names that merely share letters with card labels', () => {
    for (const name of [
      'Lukyamuzi Derrick',
      'Nakato Sarah',
      'Ssempala Ronald',
      'Nantongo Peter',
      'Namutebi Grace',
      'Ochieng Musana',
    ]) {
      const result = assessIdNameConfidence(name);
      expect(result.confident, `${name} should be confident: ${result.reason}`).toBe(true);
    }
  });

  it('still rejects the existing bad-input cases', () => {
    expect(assessIdNameConfidence('').confident).toBe(false);
    expect(assessIdNameConfidence('Bob').confident).toBe(false);
    expect(assessIdNameConfidence('J').confident).toBe(false);
    expect(assessIdNameConfidence('12345 6789').confident).toBe(false);
    expect(assessIdNameConfidence('aaaa bbbb').confident).toBe(false);
    expect(assessIdNameConfidence('Bbbbbbb Cccccc').confident).toBe(false);
    expect(assessIdNameConfidence('Nnnnn Xxxxx').confident).toBe(false);
  });
});
