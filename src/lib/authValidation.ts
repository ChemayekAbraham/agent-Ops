// Inline validation for faster processing (no zod overhead)
import { isValidPhoneNumberGlobal } from '@/lib/phoneUtils';

/**
 * Shared full-name validator used across every signup/registration screen.
 * - Trims surrounding whitespace
 * - Requires at least 2 visible characters
 * - Returns the trimmed value + an error message (null if valid)
 *
 * Always call this before submitting a registration form so we never
 * persist empty / whitespace-only / single-letter names to profiles.
 */
export const MIN_FULL_NAME_LENGTH = 2;

export interface FullNameValidationResult {
  valid: boolean;
  trimmed: string;
  error: string | null;
}

/** Obvious placeholder / dummy names we never want to persist. */
const DUMMY_NAME_WORDS = new Set([
  'test', 'testing', 'tester', 'demo', 'sample', 'example', 'dummy', 'fake',
  'user', 'users', 'admin', 'name', 'fullname', 'firstname', 'lastname',
  'unknown', 'none', 'null', 'undefined', 'na', 'nan', 'xxx', 'abc', 'abcd',
  'asdf', 'asdfg', 'asdfgh', 'qwerty', 'qwe', 'qwer', 'zxc', 'zxcv',
  'aaa', 'bbb', 'ccc', 'ddd', 'lorem', 'ipsum', 'anonymous', 'nobody',
  'me', 'my', 'myself', 'self', 'client', 'customer', 'agent', 'tenant',
  'landlord', 'supporter', 'welile', 'staff', 'employee', 'boss', 'ceo',
  'hello', 'hi', 'hey', 'yo', 'yes', 'no', 'ok', 'okay', 'good', 'bad',
  'foo', 'bar', 'baz', 'blah', 'blahblah', 'lol', 'lmao', 'wtf',
]);

/** Wildcard regex patterns for junk names the signup form tends to receive. */
const JUNK_NAME_PATTERNS: RegExp[] = [
  /^[a-z]\.?\s+[a-z]\.?$/i,          // "j k", "a. b."
  /(.)\1{2,}/,                        // any letter repeated 3+ times ("aaa", "hhhh")
  /^(.{1,3})\1+$/i,                   // short pattern repeated: "abab", "xyxyxy"
  /\b(test|demo|sample|fake|dummy|xxx|user|admin|welile)\b/i,
  /\b(name|firstname|lastname|surname)\b/i,
  /\b(asdf|qwerty|qwer|zxcv|hjkl|uiop)\b/i,
  /^[^a-zA-Z]+$/,                     // no letters at all
  /[0-9@#$%^&*_=+<>{}\[\]\\\/|~`"]/,  // digits or symbols anywhere
];

/**
 * Heuristic gibberish detector for a single name token.
 * Flags keyboard-mash / random strings like "dhfhfdhd", "hshseh", "twat".
 */
const isGibberishToken = (token: string): boolean => {
  const t = token.toLowerCase().replace(/[^a-z]/g, '');
  if (t.length < 2) return false;

  // Known dummy word.
  if (DUMMY_NAME_WORDS.has(t)) return true;

  // Real names almost always contain a vowel. Long consonant-only tokens are noise.
  // `y` counts as a vowel here — it carries the vowel sound in many real names
  // (e.g. "Gladys", "Nnamdy", "Sylvia") and excluding it flagged them as junk.
  const vowels = (t.match(/[aeiouy]/g) || []).length;
  if (t.length >= 4 && vowels === 0) return true;

  // Very low vowel ratio on longer tokens (e.g. "dhfhfdhd", "hshseh").
  if (t.length >= 5 && vowels / t.length < 0.2) return true;

  // Same character repeated (e.g. "aaaa").
  if (/^(.)\1+$/.test(t)) return true;

  // A run of 4+ identical letters (e.g. "jaaaan").
  if (/(.)\1{3,}/.test(t)) return true;

  // Four or more consecutive consonants is unnatural for a real name
  // (allow common clusters by only flagging 4+, e.g. "dhfh", "shss").
  if (/[bcdfghjklmnpqrstvwxz]{4,}/.test(t)) return true;

  // Sequential keyboard runs ("abcd", "1234"-like letter rows).
  const KEYBOARD_RUNS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'abcdefghijklmnopqrstuvwxyz'];
  for (const row of KEYBOARD_RUNS) {
    for (let i = 0; i <= row.length - 4; i++) {
      const run = row.slice(i, i + 4);
      if (t.includes(run) || t.includes(run.split('').reverse().join(''))) return true;
    }
  }

  return false;
};

export const validateFullName = (raw: string | null | undefined): FullNameValidationResult => {
  const trimmed = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (trimmed.length < MIN_FULL_NAME_LENGTH) {
    return {
      valid: false,
      trimmed,
      error: `Full name is required (minimum ${MIN_FULL_NAME_LENGTH} characters)`,
    };
  }

  // Require at least two name parts (e.g. first + last name).
  const parts = trimmed.split(' ').filter((p) => p.replace(/[^a-zA-Z]/g, '').length > 0);
  if (parts.length < 2) {
    return {
      valid: false,
      trimmed,
      error: 'Please enter at least two names (first and last name)',
    };
  }

  // Each part must have at least 2 letters.
  if (parts.some((p) => p.replace(/[^a-zA-Z]/g, '').length < 2)) {
    return {
      valid: false,
      trimmed,
      error: 'Each name must be at least 2 letters',
    };
  }

  // Reject obvious dummy / gibberish names.
  if (parts.some((p) => isGibberishToken(p))) {
    return {
      valid: false,
      trimmed,
      error: 'Please enter a real full name',
    };
  }

  // Wildcard sweep on the whole name for common junk signup patterns.
  if (JUNK_NAME_PATTERNS.some((rx) => rx.test(trimmed))) {
    return {
      valid: false,
      trimmed,
      error: 'Name looks invalid — use letters only, no digits, symbols or filler text',
    };
  }

  // Reject when both first and last names are identical (e.g. "John John").
  if (parts.length >= 2) {
    const normalized = parts.map((p) => p.toLowerCase().replace(/[^a-z]/g, ''));
    if (new Set(normalized).size === 1) {
      return {
        valid: false,
        trimmed,
        error: 'First and last name cannot be the same',
      };
    }
  }

  return { valid: true, trimmed, error: null };
};

export const validateSignUp = (data: { password: string; confirmPassword: string; fullName: string; phone: string }) => {
  if (data.password.length < 6) return 'Password must be at least 6 characters';
  if (data.password !== data.confirmPassword) return "Passwords don't match";
  const nameCheck = validateFullName(data.fullName);
  if (!nameCheck.valid) return nameCheck.error;
  
  const phoneValidation = isValidPhoneNumberGlobal(data.phone);
  if (!phoneValidation.valid) return phoneValidation.reason || 'Invalid phone number';
  
  return null;
};

export const validateSignIn = (data: { phone: string; password: string }) => {
  const phoneValidation = isValidPhoneNumberGlobal(data.phone);
  if (!phoneValidation.valid) return phoneValidation.reason || 'Invalid phone number';
  if (!data.password) return 'Password is required';
  return null;
};

export const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Request timed out. Please check your connection and try again.')), ms)
    ),
  ]);

// ---------------------------------------------------------------------------
// Person-name standardisation helpers (see
// docs/internal/reports/person-name-standardisation-design.md).
// `validateFullName` above stays the single name authority — these helpers only
// split/join the parts and delegate to it.
// ---------------------------------------------------------------------------

export interface PersonNameParts {
  firstName: string;
  otherNames: string;
  lastName: string;
}

const normalizeNamePart = (value: string | null | undefined): string =>
  (value ?? '').trim().replace(/\s+/g, ' ');

/** Joins parts as `First Other Last`, dropping empties and collapsing whitespace. */
export const joinPersonName = (parts: Partial<PersonNameParts>): string =>
  [parts?.firstName, parts?.otherNames, parts?.lastName]
    .map(normalizeNamePart)
    .filter((p) => p.length > 0)
    .join(' ');

/**
 * Splits a stored name string into parts.
 * 0 tokens -> all empty; 1 -> first only; 2 -> first + last;
 * 3+ -> first = token[0], last = last token, otherNames = middle joined.
 */
export const splitPersonName = (raw: string | null | undefined): PersonNameParts => {
  const tokens = normalizeNamePart(raw).split(' ').filter(Boolean);
  if (tokens.length === 0) return { firstName: '', otherNames: '', lastName: '' };
  if (tokens.length === 1) return { firstName: tokens[0], otherNames: '', lastName: '' };
  if (tokens.length === 2) return { firstName: tokens[0], otherNames: '', lastName: tokens[1] };
  return {
    firstName: tokens[0],
    otherNames: tokens.slice(1, -1).join(' '),
    lastName: tokens[tokens.length - 1],
  };
};

export interface PersonNamePartsValidationResult {
  valid: boolean;
  fullName: string;
  error: string | null;
}

/** Required-check on first/last, then delegates to the existing `validateFullName`. */
export const validatePersonNameParts = (
  parts: Partial<PersonNameParts>,
): PersonNamePartsValidationResult => {
  const firstName = normalizeNamePart(parts?.firstName);
  const lastName = normalizeNamePart(parts?.lastName);
  const fullName = joinPersonName(parts);

  if (!firstName) return { valid: false, fullName, error: 'First name is required' };
  if (!lastName) return { valid: false, fullName, error: 'Last name is required' };

  const check = validateFullName(fullName);
  return { valid: check.valid, fullName: check.trimmed || fullName, error: check.error };
};
