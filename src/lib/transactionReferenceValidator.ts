/**
 * Strict client-side validation for a MoMo / bank transaction reference
 * before it can be used to credit an inbound deposit email in the
 * redirect-deposit dialog.
 *
 * The backend (`cfo-direct-credit` / `verify-email-credit-status`) uses the
 * reference as the reconciliation + de-duplication key, so a weak value
 * (too short, no digits, an obvious placeholder) silently produces an
 * un-reconcilable credit. This guard fails fast in the UI and keeps the
 * Confirm button disabled until a plausible reference is supplied — whether
 * it was auto-extracted from the email body or typed by the operator.
 *
 * This is presentation-layer validation only; the DB uniqueness trigger
 * remains the authoritative gate.
 */

export interface ReferenceValidation {
  valid: boolean;
  /** Short, operator-facing reason shown when invalid. */
  message: string;
}

// Obvious junk / placeholder tokens that look like a reference but never
// identify a real MoMo or bank transaction.
const PLACEHOLDER_TOKENS = new Set([
  'NA', 'N/A', 'NONE', 'NULL', 'NIL', 'TEST', 'TESTING', 'DEMO', 'SAMPLE',
  'REF', 'REFERENCE', 'TID', 'TXN', 'TRANS', 'RECEIPT', 'CONFIRMATION',
  'UNKNOWN', 'PENDING', 'TBD', 'XXX', 'XXXX', 'XXXXX', '0000', '00000',
  '1234', '12345', '123456', 'ABCD', 'ABCDE',
]);

// Minimum number of usable characters for a real reference.
const MIN_LENGTH = 6;

/**
 * Normalise then strictly validate a transaction reference.
 * Returns { valid, message } so the caller can both gate Confirm and show
 * an inline reason.
 */
export function validateTransactionReference(raw: string | null | undefined): ReferenceValidation {
  const value = (raw ?? '').trim();

  if (!value) {
    return { valid: false, message: 'Enter the transaction reference.' };
  }

  // Allowed shape: letters, digits and common separators only. Reject any
  // value carrying spaces or stray punctuation that a real receipt number
  // would never include.
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(value)) {
    return {
      valid: false,
      message: 'Reference has invalid characters — use only letters, digits, dot, dash or slash.',
    };
  }

  // Count of alphanumeric characters (ignoring separators) must clear the bar.
  const alnum = value.replace(/[^A-Za-z0-9]/g, '');
  if (alnum.length < MIN_LENGTH) {
    return {
      valid: false,
      message: `Reference looks too short (need ≥ ${MIN_LENGTH} characters).`,
    };
  }

  // A genuine MoMo / bank reference always contains at least one digit.
  if (!/[0-9]/.test(alnum)) {
    return { valid: false, message: 'Reference must contain at least one digit.' };
  }

  // Reject obvious placeholders / dummy values.
  if (PLACEHOLDER_TOKENS.has(alnum.toUpperCase())) {
    return { valid: false, message: 'That looks like a placeholder, not a real reference.' };
  }

  // Reject a single repeated character (e.g. "000000", "AAAAAA").
  if (/^(.)\1+$/.test(alnum)) {
    return { valid: false, message: 'Reference cannot be a single repeated character.' };
  }

  return { valid: true, message: '' };
}
