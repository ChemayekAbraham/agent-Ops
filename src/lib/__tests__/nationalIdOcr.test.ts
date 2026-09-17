import { describe, expect, it } from 'vitest';
import { classifyIdPhotoOrientation, normaliseReading, readingGuidance } from '@/lib/nationalIdOcr';

describe('National ID photo orientation', () => {
  it('accepts a straight landscape photo, including an upside-down landscape photo', () => {
    expect(classifyIdPhotoOrientation(1600, 1000)).toBe('landscape');
    expect(classifyIdPhotoOrientation(1000, 600)).toBe('landscape');
  });

  it('rejects 90-degree, -90-degree and square photos as sideways', () => {
    expect(classifyIdPhotoOrientation(1000, 1600)).toBe('sideways');
    expect(classifyIdPhotoOrientation(600, 1000)).toBe('sideways');
    expect(classifyIdPhotoOrientation(1000, 1000)).toBe('sideways');
  });

  it('rejects invalid dimensions instead of passing an unusable image to OCR', () => {
    expect(classifyIdPhotoOrientation(0, 1000)).toBe('unreadable');
    expect(classifyIdPhotoOrientation(Number.NaN, 1000)).toBe('unreadable');
  });
});

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

  it('keeps letters in a new-format NIRA card number instead of stripping them', () => {
    const r = normaliseReading({
      status: 'valid', is_national_id: true,
      data: { card_number: 'CA144787388' },
      fields: {},
    });
    expect(r.data.card_number).toBe('CA144787388');

    // Also exercised via the `fields`-only fallback path (older reader shape).
    const viaFields = normaliseReading({
      fields: { card_number: { value: 'ca144787388', valid: false } },
    });
    expect(viaFields.data.card_number).toBe('CA144787388');
  });
});

describe('date of birth', () => {
  it('accepts the ISO the new reader returns', () => {
    const r = normaliseReading({ data: { date_of_birth: '1990-06-14' } });
    expect(r.data.date_of_birth).toBe('1990-06-14');
  });

  it("converts the old reader's printed spelling so the date field fills", () => {
    // `14.06.1990` is what the card prints and what the older reader returned
    // verbatim. A date input silently refuses it, so the field looked empty.
    for (const printed of ['14.06.1990', '14/06/1990', '14-06-1990', '4.6.1990']) {
      expect(normaliseReading({ date_of_birth: printed }).data.date_of_birth)
        .toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(normaliseReading({ date_of_birth: '14.06.1990' }).data.date_of_birth).toBe('1990-06-14');
  });

  it('drops a date that is not real rather than letting the browser roll it over', () => {
    expect(normaliseReading({ date_of_birth: '31.02.1990' }).data.date_of_birth).toBe('');
    expect(normaliseReading({ date_of_birth: '14.13.1990' }).data.date_of_birth).toBe('');
    expect(normaliseReading({ date_of_birth: 'not a date' }).data.date_of_birth).toBe('');
  });
});
