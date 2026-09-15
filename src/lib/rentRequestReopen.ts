/**
 * Rent-request resubmission allowance — presentation helpers.
 *
 * The authority is the database: public.agent_resubmit_rent_request enforces the
 * cap and public.rent_request_stale_return decides whether a reviewer return was
 * about staleness/expiry rather than a correction the agent can make. These
 * helpers mirror those rules so the agent sees the same answer the server will
 * give. They never decide anything on their own.
 */

/** Same cap as `_resubmit_cap` in public.agent_resubmit_rent_request. */
export const RESUBMIT_CAP = 5;

/** Mirrors public.rent_request_stale_return(text). */
export function isStaleReturnReason(reason?: string | null): boolean {
  return /(expir|stale|out of date|outdated|too old)/i.test(reason ?? '');
}

/**
 * Attempts the agent has left on a returned request. A stale/expiry return
 * neither consumes the allowance nor is blocked by it, so it reads as unlimited.
 */
export function resubmitAttemptsLeft(
  reopenCount: number | null | undefined,
  rejectedReason?: string | null,
): number | null {
  if (isStaleReturnReason(rejectedReason)) return null;
  return Math.max(0, RESUBMIT_CAP - Number(reopenCount || 0));
}
