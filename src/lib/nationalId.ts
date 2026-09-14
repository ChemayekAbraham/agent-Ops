/**
 * National ID (NIN) validation.
 *
 * Single source of truth for what the app accepts as a National ID before the
 * value is sent to `submit_national_id`. The database RPC re-checks the same
 * rules (10–14 alphanumeric characters, a spaced name of 4+ characters), so
 * this is a fast-fail layer, never the only one.
 *
 * Uganda NIN shape (NIRA): 14 characters, all uppercase alphanumeric, starting
 * with `C` for a citizen or `A` for an alien/refugee card, followed by `M`/`F`
 * for sex. Older or replacement cards in circulation can be shorter, so any
 * 10–14 alphanumeric value is accepted; the 14-character citizen/alien pattern
 * is enforced only when the value clearly claims to be one.
 */

export const NATIONAL_ID_MIN_LENGTH = 10;
export const NATIONAL_ID_MAX_LENGTH = 14;

/** Uppercase and strip anything that is not a letter or digit. */
export function normalizeNationalId(raw: string): string {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, NATIONAL_ID_MAX_LENGTH);
}

export interface NationalIdCheck {
  valid: boolean;
  /** Cleaned value safe to submit. */
  value: string;
  /** Plain-language problem, shown under the field. */
  error?: string;
}

export function validateNationalId(raw: string): NationalIdCheck {
  const value = normalizeNationalId(raw);

  if (!value) {
    return { valid: false, value, error: 'Enter the National ID number printed on your card.' };
  }
  if (/^(.)\1+$/.test(value)) {
    return { valid: false, value, error: 'That is not a real National ID number.' };
  }
  if (value.length < NATIONAL_ID_MIN_LENGTH) {
    return {
      valid: false,
      value,
      error: `Too short — a National ID has at least ${NATIONAL_ID_MIN_LENGTH} characters. You typed ${value.length}.`,
    };
  }
  if (!/[0-9]/.test(value)) {
    return { valid: false, value, error: 'A National ID number contains digits as well as letters.' };
  }

  // Ugandan cards start with C (citizen) or A (alien/refugee) followed by M/F.
  if (/^[CA]/.test(value)) {
    if (!/^[CA][MF]/.test(value)) {
      return {
        valid: false,
        value,
        error: 'Check the first characters — a Ugandan National ID starts CM or CF (or AM/AF).',
      };
    }
    if (value.length !== NATIONAL_ID_MAX_LENGTH) {
      return {
        valid: false,
        value,
        error: `A Ugandan National ID has exactly ${NATIONAL_ID_MAX_LENGTH} characters. You typed ${value.length}.`,
      };
    }
  }

  return { valid: true, value };
}

export interface NationalIdNameCheck {
  valid: boolean;
  value: string;
  error?: string;
}

/**
 * The name must be the one printed on the card: at least two words, letters
 * only (hyphens and apostrophes allowed), because Financial Ops compares it
 * word-by-word against the mobile money or bank account name.
 */
export function validateNationalIdName(raw: string): NationalIdNameCheck {
  const value = String(raw ?? '').replace(/\s+/g, ' ').trim();

  if (!value) {
    return { valid: false, value, error: 'Enter your name exactly as printed on the ID.' };
  }
  if (value.length < 4) {
    return { valid: false, value, error: 'That name is too short to match a payout account.' };
  }
  if (/\d/.test(value)) {
    return { valid: false, value, error: 'A name has no numbers in it.' };
  }
  if (!/^[A-Za-z][A-Za-z'\-. ]*$/.test(value)) {
    return { valid: false, value, error: 'Use letters only, as printed on the ID.' };
  }
  const words = value.split(' ').filter((w) => w.replace(/[^A-Za-z]/g, '').length >= 2);
  if (words.length < 2) {
    return { valid: false, value, error: 'Enter both names, for example Nakato Sarah.' };
  }

  return { valid: true, value };
}

/**
 * One National ID may only ever belong to one account. The database enforces
 * this with the unique index `profiles_national_id_unique_norm`, so a second
 * account submitting the same ID fails with a Postgres unique violation
 * (23505) — or with a plain-language refusal from `submit_national_id` when
 * the RPC catches it first. Both shapes are mapped to a single user-facing
 * message here so every entry point says the same thing.
 */
export const DUPLICATE_NATIONAL_ID_MESSAGE =
  'Duplicate National ID rejected — this National ID is already registered on another account. One National ID can only belong to one account.';

export function isDuplicateNationalIdError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: string }).code;
  if (code === '23505') return true;
  const msg = String((err as { message?: string }).message ?? err).toLowerCase();
  return (
    msg.includes('profiles_national_id_unique_norm') ||
    msg.includes('duplicate national id rejected') ||
    (msg.includes('national id') &&
      (msg.includes('duplicate') || msg.includes('already') || msg.includes('another account')))
  );
}
