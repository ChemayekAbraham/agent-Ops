/**
 * Shared full-name validator for edge functions.
 * Mirrors the client helper in src/lib/authValidation.ts (validateFullName)
 * AND the database trigger public.enforce_profile_full_name(), so users see the
 * exact same message no matter which layer rejects the input.
 *
 * Rules:
 *   - Must be a string
 *   - Trim leading/trailing whitespace
 *   - Collapse internal whitespace ("John   Doe" → "John Doe")
 *   - Minimum 2 visible characters
 *   - Maximum 100 characters (defensive cap)
 */
export const MIN_FULL_NAME_LENGTH = 2;
export const MAX_FULL_NAME_LENGTH = 100;

export const FULL_NAME_ERROR = `Full name is required (minimum ${MIN_FULL_NAME_LENGTH} characters)`;
export const FULL_NAME_TOO_LONG_ERROR = `Full name must be at most ${MAX_FULL_NAME_LENGTH} characters`;

export interface FullNameValidation {
  valid: boolean;
  trimmed: string;
  error: string | null;
}

export function validateFullName(raw: unknown): FullNameValidation {
  if (typeof raw !== "string") {
    return { valid: false, trimmed: "", error: FULL_NAME_ERROR };
  }
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (trimmed.length < MIN_FULL_NAME_LENGTH) {
    return { valid: false, trimmed, error: FULL_NAME_ERROR };
  }
  if (trimmed.length > MAX_FULL_NAME_LENGTH) {
    return { valid: false, trimmed, error: FULL_NAME_TOO_LONG_ERROR };
  }
  return { valid: true, trimmed, error: null };
}

/**
 * Translates a Postgres error from the enforce_profile_full_name trigger
 * into the same friendly client-facing message. Falls back to the original
 * message for unrelated errors.
 */
export function mapProfileFullNameDbError(
  error: { message?: string; code?: string } | null | undefined,
): string | null {
  if (!error) return null;
  const msg = error.message || "";
  if (
    msg.includes("Full name is required") ||
    (error.code === "23514" && msg.toLowerCase().includes("full name"))
  ) {
    return FULL_NAME_ERROR;
  }
  return msg || "Database error";
}