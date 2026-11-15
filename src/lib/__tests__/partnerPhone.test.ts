import { describe, expect, it } from 'vitest';
import {
  CUT_NUMBER_MESSAGE, cleanPhoneInput, isCutUgNumber, isValidPhone, partnerPhoneProblem, toStoredPhone,
} from '@/lib/partnerPhone';

describe('partner phone numbers (Promissory Note and Empty-house sheet)', () => {
  it('keeps "+256 786 358012" whole while typing and stores 256786358012', () => {
    expect(cleanPhoneInput('+256 786 358012')).toBe('+256 786 358012');
    expect(partnerPhoneProblem('+256 786 358012')).toBeNull();
    expect(toStoredPhone('+256 786 358012')).toBe('256786358012');
  });

  it('accepts 0786358012 and stores it with the country code', () => {
    expect(partnerPhoneProblem('0786358012')).toBeNull();
    expect(toStoredPhone('0786358012')).toBe('256786358012');
  });

  it('rejects the cut number 2567863580 with the plain message', () => {
    expect(isCutUgNumber('2567863580')).toBe(true);
    expect(partnerPhoneProblem('2567863580')).toBe(CUT_NUMBER_MESSAGE);
    expect(CUT_NUMBER_MESSAGE).toBe('Number looks cut — type it as 07XXXXXXXX');
  });

  it('treats any 256-number that is not 12 digits as cut, however it is written', () => {
    expect(isCutUgNumber('+256 786 3580123')).toBe(true);
    expect(isCutUgNumber('00256 786 35801')).toBe(true);
    expect(isCutUgNumber('00256 786 358012')).toBe(false);
  });

  it('accepts other international numbers of 7 to 15 digits, and drops junk while typing', () => {
    expect(isValidPhone('+44 7700 900123')).toBe(true);
    expect(isValidPhone('123456')).toBe(false);
    expect(isValidPhone('1234567890123456')).toBe(false);
    expect(cleanPhoneInput('07a8b6-358#012')).toBe('0786-358012');
  });
});
