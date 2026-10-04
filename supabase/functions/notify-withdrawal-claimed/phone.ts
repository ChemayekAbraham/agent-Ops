// Shared Ugandan phone / MoMo number helpers. Extracted so they can be
// unit-tested in isolation without booting the edge function's HTTP server.

/**
 * Normalize a raw phone/MoMo string to E.164 international format for Uganda.
 * - Strips all non-digit characters.
 * - `256…`  → `+256…`
 * - `0XXXXXXXXX` (local trunk) → `+256XXXXXXXXX`
 * - 9 bare digits → `+256XXXXXXXXX`
 * - anything else with digits → `+<digits>` (best effort)
 * - empty/no digits → "".
 */
export function formatPhoneInternational(phone: string): string {
  const digits = (phone || "").replace(/[^0-9]/g, "");
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return digits ? `+${digits}` : "";
}

/** True only for well-formed Ugandan numbers (+256 followed by 9 digits). */
export function isUgandanPhone(phone: string): boolean {
  const f = formatPhoneInternational(phone);
  return f.startsWith("+256") && f.length >= 13;
}
