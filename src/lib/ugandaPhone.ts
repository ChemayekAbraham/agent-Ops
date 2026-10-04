import { z } from 'zod';

/**
 * Shared Ugandan phone-number validation + normalisation.
 *
 * Used to guard Call / WhatsApp actions on the client so we never hand an
 * invalid number to `tel:` / `wa.me`. The same rules are mirrored server-side
 * (supabase/functions/_shared/ugandaPhone.ts) so invalid numbers can never be
 * persisted in the first place.
 *
 * Valid Ugandan mobile numbers normalise to E.164 `256[3-9]XXXXXXXX`
 * (12 digits, no leading '+'). Accepted inputs:
 *   - local:        0XXXXXXXXX        (10 digits, 2nd digit 3-9)
 *   - bare 9-digit: XXXXXXXXX         (1st digit 3-9)
 *   - international: 256XXXXXXXXX / +256XXXXXXXXX
 */

const E164_UG_REGEX = /^256[3-9][0-9]{8}$/;

export interface UgandaPhoneResult {
  valid: boolean;
  /** E.164 digits without '+', e.g. "256759229748". Null when invalid. */
  e164: string | null;
  /** Human error message when invalid. */
  error?: string;
}

/** Normalise any accepted input to bare E.164 digits, or null if impossible. */
export function toUgandaE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;

  if (digits.startsWith('256')) {
    // already international
  } else if (digits.startsWith('0')) {
    digits = `256${digits.slice(1)}`;
  } else if (digits.length === 9) {
    digits = `256${digits}`;
  } else {
    // Unrecognised shape — leave as-is so validation can reject it.
    digits = digits.startsWith('256') ? digits : `256${digits}`;
  }

  return E164_UG_REGEX.test(digits) ? digits : null;
}

/** Full validation result with an error message for UI display. */
export function validateUgandaPhone(raw: string | null | undefined): UgandaPhoneResult {
  if (raw == null || String(raw).trim() === '') {
    return { valid: false, e164: null, error: 'Phone number is required' };
  }
  const e164 = toUgandaE164(raw);
  if (!e164) {
    return { valid: false, e164: null, error: 'Enter a valid Ugandan phone number' };
  }
  return { valid: true, e164 };
}

/** True when the number is a dialable Ugandan mobile number. */
export function isValidUgandaPhone(raw: string | null | undefined): boolean {
  return validateUgandaPhone(raw).valid;
}

/** Zod schema for forms — transforms to E.164 digits on success. */
export const ugandaPhoneSchema = z
  .string({ message: 'Phone number is required' })
  .trim()
  .min(1, 'Phone number is required')
  .max(20, 'Phone number is too long')
  .transform((val, ctx) => {
    const e164 = toUgandaE164(val);
    if (!e164) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a valid Ugandan phone number',
      });
      return z.NEVER;
    }
    return e164;
  });