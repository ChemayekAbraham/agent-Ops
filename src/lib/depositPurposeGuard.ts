export const ALLOWED_DEPOSIT_PURPOSES = [
  'operational_float',
  'personal_deposit',
  'partnership_deposit',
  'personal_rent_repayment',
  'other',
] as const;

export type DepositPurpose = typeof ALLOWED_DEPOSIT_PURPOSES[number];

/**
 * Final client-side guard before any insert/update touches `deposit_requests`.
 *
 * Returns a guaranteed-valid `deposit_purpose` enum value. Empty strings,
 * null, undefined, whitespace, or stale/legacy values are coerced to
 * `'other'` so Postgres NEVER receives `''` (which raises the cryptic
 * `invalid input value for enum deposit_purpose: ""` error and leaves
 * the user staring at a dead Confirm button).
 *
 * `'other'` is chosen as the safe default because:
 *   • It is already a valid value in the `deposit_purpose` enum.
 *   • `approve-deposit` and Financial Ops review queues already handle it.
 *   • It is intentionally vague, so a defaulted row is easy to triage.
 */
export function safeDepositPurpose(raw: unknown): DepositPurpose {
  if (typeof raw !== 'string') return 'other';
  const trimmed = raw.trim();
  if (!trimmed) return 'other';
  return (ALLOWED_DEPOSIT_PURPOSES as readonly string[]).includes(trimmed)
    ? (trimmed as DepositPurpose)
    : 'other';
}