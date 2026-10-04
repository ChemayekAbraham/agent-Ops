// Server-side mirror of src/lib/ugandaPhone.ts.
// Keep the rules in sync with the client so a number that enables Call /
// WhatsApp on the client can never be persisted unless it is also valid here.

const E164_UG_REGEX = /^256[3-9][0-9]{8}$/;

export interface UgandaPhoneResult {
  valid: boolean;
  e164: string | null;
  error?: string;
}

export function toUgandaE164(raw: unknown): string | null {
  if (raw == null) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;

  if (digits.startsWith("256")) {
    // already international
  } else if (digits.startsWith("0")) {
    digits = `256${digits.slice(1)}`;
  } else if (digits.length === 9) {
    digits = `256${digits}`;
  } else {
    digits = digits.startsWith("256") ? digits : `256${digits}`;
  }

  return E164_UG_REGEX.test(digits) ? digits : null;
}

export function validateUgandaPhone(raw: unknown): UgandaPhoneResult {
  if (raw == null || String(raw).trim() === "") {
    return { valid: false, e164: null, error: "Phone number is required" };
  }
  const e164 = toUgandaE164(raw);
  if (!e164) {
    return { valid: false, e164: null, error: "Enter a valid Ugandan phone number" };
  }
  return { valid: true, e164 };
}

export function isValidUgandaPhone(raw: unknown): boolean {
  return validateUgandaPhone(raw).valid;
}