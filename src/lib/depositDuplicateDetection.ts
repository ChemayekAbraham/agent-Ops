/**
 * Detects deposits that were auto-cancelled by `try_link_gmail_for_deposit`
 * because the same mobile-money transaction reference had already been
 * credited from a prior auto-matched Gmail receipt.
 *
 * These rows are technically `status='rejected'` in the database (so the
 * pending queue doesn't dangle), but they are NOT a true rejection — the
 * depositor was already paid. The UI should surface this distinct case
 * with a neutral / success-tinted "Already credited" state instead of a
 * red "Rejected" badge, and must NOT prompt the user to resubmit.
 *
 * Detection is keyed off the human-readable prefix the RPC writes into
 * `rejection_reason`. Keep this string in sync with the migration.
 */
export const DUPLICATE_REASON_PREFIX =
  'Already credited from your mobile-money receipt';

export function isAutoCancelledDuplicate(d: {
  status?: string | null;
  rejection_reason?: string | null;
}): boolean {
  return (
    d.status === 'rejected' &&
    !!d.rejection_reason &&
    d.rejection_reason.startsWith(DUPLICATE_REASON_PREFIX)
  );
}