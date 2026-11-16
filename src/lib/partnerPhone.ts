/**
 * Phone rules for partner contacts (Quick Promissory Note and the Empty-house sheet):
 * keep what was typed or pasted while typing, accept any international number of 7–15
 * digits, and store it as bare international digits (normalizeWa) on submit.
 */
import { normalizeWa } from '@/lib/whatsapp';

export const phoneDigits = (v: string): string => (v || '').replace(/\D/g, '');

/** Keep what the person typed/pasted, just drop junk characters. */
export const cleanPhoneInput = (v: string): string => (v || '').replace(/[^\d+\s()\-.]/g, '').slice(0, 24);

/** Accepts any international number: 7–15 digits (E.164 range). */
export const isValidPhone = (v: string): boolean => {
  const d = phoneDigits(v);
  return d.length >= 7 && d.length <= 15;
};

export const CUT_NUMBER_MESSAGE = 'Number looks cut — type it as 07XXXXXXXX';

/**
 * A Ugandan number written with its country code (256…, +256…, 00256…) must have 12
 * digits. Anything else with that prefix was cut short or run on, e.g. "2567863580".
 */
export const isCutUgNumber = (v: string): boolean => {
  let d = phoneDigits(v);
  if (d.startsWith('00')) d = d.slice(2);
  return d.startsWith('256') && d.length !== 12;
};

/** The problem with a typed number, or null when it is fine. */
export const partnerPhoneProblem = (v: string): string | null => {
  if (isCutUgNumber(v)) return CUT_NUMBER_MESSAGE;
  if (!isValidPhone(v)) return 'Enter a phone number of 7 to 15 digits';
  return null;
};

/** What is stored: bare international digits, e.g. "+256 786 358012" → "256786358012". */
export const toStoredPhone = (v: string): string => normalizeWa(v);
