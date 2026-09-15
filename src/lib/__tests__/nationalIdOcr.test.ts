import { describe, expect, it } from 'vitest';
import { normaliseReading, readingGuidance } from '@/lib/nationalIdOcr';

/**
 * The reader is an edge function deployed by hand, so the browser and the
 * function are routinely different versions. A response shape the screen did
 * not expect once took the whole agent dashboard down with
 * "Cannot read properties of undefined (reading 'length')".
 */
describe('normaliseReading', () => {
  it('survives the older reader that had no status, missing or consistency', () => {
    const r = normaliseReading({
      full_name: 'SARAH OKELLO',
      surname: 'OKELLO',
      given_names: 'SARAH',
      id_number: 'cf9012345ab67c',
      date_of_birth: '1990-06-14',
      is_national_id: true,
      readable: true,
      account_name: 'Sarah Okello',
      name_match_score: 1,
    });

    expect(Array.isArray(r.consistency)).toBe(true);
    expect(Array.isArray(r.missing)).toBe(true);
    // Old spellings are mapped onto the six-field form, uppercased.
    expect(r.data.nin).toBe('CF9012345AB67C');
    expect(r.data.given_name).toBe('SARAH');
    // Card number and sex were never returned, so they are the fields to type.
    expect(r.missing).toEqual(expect.arrayContaining(['card_number', 'sex']));
    expect(r.status).toBe('incomplete');
    expect(readingGuidance(r)).toContain('Card number');
  });

  it('survives an entirely empty body', () => {
    const r = normaliseReading(undefined);
    expect(r.consistency).toEqual([]);
    expect(r.data.nin).toBe('');
    expect(r.status).toBe('incomplete');
    expect(() => readingGuidance(r)).not.toThrow();
  });

  it('keeps a real reading intact and refuses a non-ID', () => {
    const ok = normaliseReading({
      status: 'valid', is_national_id: true, confidence: 0.59, sha256: 'abc',
      full_name: 'SARAH OKELLO',
      data: { surname: 'OKELLO', given_name: 'SARAH', nin: 'CF9012345AB67C',
              date_of_birth: '1990-06-14', card_number: '012345678', sex: 'F' },
      fields: { nin: { value: 'CF9012345AB67C', confidence: 0.86, valid: true } },
      missing: [], consistency: [{ id: 'nin_sex_agreement', passed: true, detail: 'agree' }],
    });
    expect(ok.status).toBe('valid');
    expect(ok.data.card_number).toBe('012345678');
    expect(readingGuidance(ok)).toBeNull();

    const bad = normaliseReading({ status: 'invalid', is_national_id: false });
    expect(bad.status).toBe('invalid');
    expect(readingGuidance(bad)).toContain('not a Ugandan National ID');
  });
});
