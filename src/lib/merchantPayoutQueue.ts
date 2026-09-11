/**
 * Single source of truth for "is this withdrawal actionable in the Merchant
 * Agent payout queue?".
 *
 * Mirrors the database view `public.v_merchant_payout_queue` exactly:
 *
 *   status IN (queue statuses)
 *   AND processed_at IS NULL
 *   AND fin_ops_reference IS NULL
 *   AND hidden_from_merchant_queue IS NOT TRUE
 *
 * The database is the enforcing authority (the view plus the
 * `trg_enforce_settled_withdrawal_terminal` trigger, which refuses to move a
 * settled/evidence-carrying payout back into any queue state). This module
 * exists so every client read, badge count, realtime handler and render filter
 * uses the identical predicate instead of re-deriving it — a paid payout can
 * therefore never be re-inserted into the queue by a stale cache, an optimistic
 * update, a retry, or a duplicate confirmation.
 */

/** Statuses that mean "still waiting to be paid out". */
export const MERCHANT_QUEUE_STATUSES = [
  'pending',
  'requested',
  'manager_approved',
  'cfo_approved',
  'fin_ops_approved',
] as const;

/**
 * Statuses that are settled/withdrawn from the queue forever. Listed for
 * documentation and tests; the predicate below is an allow-list, so any status
 * not in MERCHANT_QUEUE_STATUSES (including future ones) is excluded by default.
 */
export const MERCHANT_TERMINAL_STATUSES = [
  'paid',
  'completed',
  'disbursed',
  'rejected',
  'cancelled',
  'failed',
  'processing',
  'held',
] as const;

export interface MerchantQueueRowLike {
  status?: string | null;
  processed_at?: string | null;
  fin_ops_reference?: string | null;
  hidden_from_merchant_queue?: boolean | null;
}

/** True only for rows that genuinely still need a merchant payout. */
export function isMerchantQueueActionable(row: MerchantQueueRowLike | null | undefined): boolean {
  if (!row) return false;
  const status = String(row.status || '');
  if (!(MERCHANT_QUEUE_STATUSES as readonly string[]).includes(status)) return false;
  // Settlement evidence outranks the status column: if a payment reference or a
  // processed timestamp exists, the cash already left and the row is closed.
  if (row.processed_at != null) return false;
  if (row.fin_ops_reference != null) return false;
  // FinOps can manually suppress a row from the merchant queue (e.g. it's
  // being handled through an alternate channel) without changing its status.
  if (row.hidden_from_merchant_queue === true) return false;
  return true;
}

/** Inverse helper used by realtime handlers to evict rows from cached pages. */
export function isMerchantQueueSettled(row: MerchantQueueRowLike | null | undefined): boolean {
  return !isMerchantQueueActionable(row);
}

/**
 * Applies the queue fence to a PostgREST query builder. Every merchant queue
 * read MUST go through this so the filter can never drift between call sites.
 */
export function applyMerchantQueueFence<T>(q: T): T {
  return (q as any)
    .in('status', MERCHANT_QUEUE_STATUSES as unknown as string[])
    .is('processed_at', null)
    .is('fin_ops_reference', null)
    .not('hidden_from_merchant_queue', 'is', true) as T;
}
