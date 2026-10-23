// Keep one-time codes out of `sms_delivery_log`.
//
// The log is readable by manager / cfo / ceo / coo / cto / super_admin — 65
// people as at 2026-10-23 — and the restrictive staff-MFA policy on it is a
// no-op while `staff_mfa_config.mode` is 'shadow', so a password-only staff
// session is enough. Writing the live code there means anyone with that access
// can authorise a withdrawal, complete a password reset, or clear a new-device
// step-up for somebody else, for as long as the code is valid.
//
// Measured 2026-10-23: 2,115 rows in 30 days carried a real code, 134 of them
// in the previous 24 hours, across wallet_withdrawal_otp, password-reset-sms,
// rent_renewal_otp, device-step-up, the cash-deposit senders and
// phone_change_old_number_otp. `issue-landlord-payout-otp` was the only sender
// already withholding it.
//
// We redact rather than drop the message, so the audit row keeps the real
// wording, character count and segment count — the things the SMS dashboard
// reports — without ever holding a usable code.

/**
 * Digits in a code context. Deliberately narrow: amounts ("UGX 1,000,000"),
 * masked tails ("ending 9270", "***573") and phone numbers must survive.
 */

/** `code: 123456` — the digits are the SECOND group. */
const CODE_AFTER: RegExp[] = [
  /(\bcode\s*[:#]?\s*)(\d{4,8})\b/gi,
  /(\bOTP\s*[:#]?\s*)(\d{4,8})\b/gi,
  /(\bPIN\s*[:#]?\s*)(\d{4,8})\b/gi,
];

/** `123456 is your code` — the digits are the FIRST group. */
const CODE_BEFORE: RegExp[] = [
  /\b(\d{4,8})(\s+is your (?:code|OTP|PIN))/gi,
];

const mask = (s: string) => "*".repeat(s.length);

/**
 * Mask any one-time code in `message`.
 *
 * Pass `code` when the caller knows it — that is exact and cannot miss a
 * wording the patterns do not cover. The patterns then run as well, so a
 * second code in the same text is still caught.
 */
export function redactSmsCodes(
  message: string | null | undefined,
  code?: string | null,
): string | null {
  if (message === null || message === undefined) return message ?? null;
  let out = String(message);

  // Exact first: the caller's own code, however it is worded.
  if (code) {
    const c = String(code).trim();
    if (c.length >= 3) out = out.split(c).join(mask(c));
  }

  // The two shapes are handled separately because String.replace passes the
  // match offset straight after the capture groups — a single positional
  // callback cannot tell a 2-group pattern from a 3-group one, and silently
  // masks the label instead of the digits.
  for (const re of CODE_AFTER) {
    out = out.replace(re, (_m, lead: string, digits: string) => `${lead}${mask(digits)}`);
  }
  for (const re of CODE_BEFORE) {
    out = out.replace(re, (_m, digits: string, tail: string) => `${mask(digits)}${tail}`);
  }

  return out;
}
