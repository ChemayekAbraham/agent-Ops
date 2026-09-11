/**
 * Client side of the canonical Merchant Agent claim transaction
 * (`claim_withdrawal_verified` + `get_withdrawal_claim_status`, migration
 * 20260912010000_canonical_merchant_claim.sql).
 *
 * The server is the only place a claim happens. This module only decides what
 * the merchant sees for each server answer -- including "the network lost the
 * answer" -- and how the returned claim is written into the cached lists. Pure
 * functions, so every outcome is unit-tested (src/lib/__tests__/merchantClaim.test.ts).
 */

/** A claimed withdrawal as the RPC returns it: the full row + `profiles`. */
export type ClaimedWithdrawal = Record<string, unknown> & {
  id: string;
  assigned_cashout_agent_id: string | null;
  dispatched_at?: string | null;
};

export interface ClaimRpcResponse {
  success?: boolean;
  idempotent?: boolean;
  already_owned_by_you?: boolean;
  result_code?: string;
  error?: string | null;
  message?: string | null;
  blocking_withdrawal_id?: string | null;
  withdrawal_id?: string;
  claim?: ClaimedWithdrawal | null;
  reservation?: Record<string, unknown> | null;
  ok?: boolean;
}

export type ClaimStatusState =
  | 'mine'
  | 'mine_closed'
  | 'other'
  | 'unassigned'
  | 'not_actionable'
  | 'not_found'
  | 'unknown';

export interface ClaimStatusResponse {
  state: ClaimStatusState;
  claim?: ClaimedWithdrawal | null;
  reservation?: Record<string, unknown> | null;
  error?: string;
}

/** Where every Claim tap ends. There is no silent branch. */
export type ClaimOutcome =
  | { kind: 'claimed'; claim: ClaimedWithdrawal | null; idempotent: boolean; message: string }
  | { kind: 'blocked_active_claim'; blockingWithdrawalId: string | null; message: string }
  | { kind: 'rejected'; code: string; tone: 'info' | 'error'; message: string }
  | { kind: 'not_claimed_retry'; message: string }
  | { kind: 'unconfirmed'; message: string }
  /** The response was lost or unreadable: ask the server before saying anything. */
  | { kind: 'ambiguous' };

export const CLAIM_MESSAGES = {
  claimed: 'Withdrawal claimed — proceed with payout.',
  alreadyYours: 'Already yours — opened your existing claim.',
  recoveredAfterNetwork: 'Your claim went through — the payout is now under "Claimed by you".',
  otherAgent: 'This withdrawal was claimed by another Merchant Agent.',
  finishExisting: 'Finish your existing payout first — it is pinned at the top.',
  notAuthorized: 'You are not authorized for this payout.',
  priority: 'A priority payout must be processed first.',
  float: 'Your payout float could not be reserved. Nothing was claimed.',
  closed: 'This withdrawal is no longer in the payout queue.',
  checking: 'Could not confirm the claim yet — checking status…',
  notClaimed: 'The claim did not complete. You can retry.',
  unconfirmed: 'We could not confirm the claim yet. Do not pay the customer until the claim status is confirmed.',
} as const;

const AUTH_ERRORS = new Set([
  'not_authenticated', 'not_cashout_agent', 'not_merchant_agent',
  'not_authorized_for_payout', 'provider_not_assigned',
]);
const PRIORITY_ERRORS = new Set(['landlord_priority_hold', 'proxy_priority_hold']);
const CLOSED_ERRORS = new Set(['not_available', 'not_found']);

/** Map one claim RPC response (queue button or dispatch pop-up) to an outcome. */
export function outcomeFromClaimResponse(res: ClaimRpcResponse | null | undefined): ClaimOutcome {
  if (!res || typeof res !== 'object') return { kind: 'ambiguous' };
  if (res.success === true || (res.ok === true && !res.error)) {
    const idempotent = res.idempotent === true;
    return {
      kind: 'claimed',
      claim: res.claim ?? null,
      idempotent,
      message: idempotent ? CLAIM_MESSAGES.alreadyYours : CLAIM_MESSAGES.claimed,
    };
  }
  const code = String(res.error ?? '');
  const serverMessage = res.message ?? null;
  if (!code) return { kind: 'ambiguous' };
  if (code === 'active_claim_exists') {
    return { kind: 'blocked_active_claim', blockingWithdrawalId: res.blocking_withdrawal_id ?? null, message: CLAIM_MESSAGES.finishExisting };
  }
  if (code === 'already_claimed') return { kind: 'rejected', code, tone: 'info', message: CLAIM_MESSAGES.otherAgent };
  if (CLOSED_ERRORS.has(code)) return { kind: 'rejected', code, tone: 'info', message: CLAIM_MESSAGES.closed };
  if (AUTH_ERRORS.has(code)) return { kind: 'rejected', code, tone: 'error', message: serverMessage || CLAIM_MESSAGES.notAuthorized };
  if (PRIORITY_ERRORS.has(code)) return { kind: 'rejected', code, tone: 'error', message: serverMessage || CLAIM_MESSAGES.priority };
  if (res.result_code === 'CLAIM_RESERVATION_FAILED' || code === 'pool_exhausted') {
    return { kind: 'rejected', code, tone: 'error', message: serverMessage || CLAIM_MESSAGES.float };
  }
  // The server rolled everything back and said so: definitely not claimed.
  if (code === 'claim_failed') return { kind: 'not_claimed_retry', message: serverMessage || CLAIM_MESSAGES.notClaimed };
  return { kind: 'rejected', code, tone: 'error', message: serverMessage || CLAIM_MESSAGES.notClaimed };
}

/** Map the authoritative "who owns this withdrawal now?" answer to an outcome. */
export function outcomeFromClaimStatus(status: ClaimStatusResponse | null | undefined): ClaimOutcome {
  switch (status?.state) {
    case 'mine':
      return { kind: 'claimed', claim: status.claim ?? null, idempotent: true, message: CLAIM_MESSAGES.recoveredAfterNetwork };
    case 'other':
      return { kind: 'rejected', code: 'already_claimed', tone: 'info', message: CLAIM_MESSAGES.otherAgent };
    case 'unassigned':
      return { kind: 'not_claimed_retry', message: CLAIM_MESSAGES.notClaimed };
    case 'mine_closed':
    case 'not_actionable':
    case 'not_found':
      return { kind: 'rejected', code: status.state, tone: 'info', message: CLAIM_MESSAGES.closed };
    default:
      return { kind: 'unconfirmed', message: CLAIM_MESSAGES.unconfirmed };
  }
}

/**
 * True when a transport/HTTP failure leaves it UNKNOWN whether the claim
 * committed (lost response, timeout, abort, 5xx, offline). A PostgREST 4xx
 * with a code is a definite refusal and is not ambiguous.
 */
export function isAmbiguousTransportError(error: unknown, aborted = false): boolean {
  if (aborted) return true;
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; details?: unknown; code?: unknown };
  const name = String(e.name ?? '');
  if (name === 'AbortError' || name === 'TypeError') return true;
  const status = Number(e.status ?? e.statusCode ?? NaN);
  if (Number.isFinite(status)) return status === 0 || status === 408 || status === 429 || status >= 500;
  const text = `${e.message ?? ''} ${e.details ?? ''}`;
  if (/fetch|network|timeout|timed out|load failed|connection|offline|abort/i.test(text)) return true;
  // No HTTP status and no recognisable PostgREST code: we cannot know.
  return !e.code;
}

/** Map an RPC transport/HTTP error to an outcome: ambiguous unless definitely refused. */
export function outcomeFromRpcError(error: unknown, aborted = false): ClaimOutcome {
  if (isAmbiguousTransportError(error, aborted)) return { kind: 'ambiguous' };
  const e = (error ?? {}) as { code?: unknown; message?: unknown };
  return {
    kind: 'rejected',
    code: String(e.code || 'rpc_error'),
    tone: 'error',
    message: String(e.message || CLAIM_MESSAGES.notClaimed),
  };
}

/** Cached "Claimed by you" list updater (React Query setQueryData). */
export const withClaimUpserted = (claim: ClaimedWithdrawal) =>
  (old: ClaimedWithdrawal[] | undefined): ClaimedWithdrawal[] => upsertClaimedRow(old, claim);

/**
 * Ask the server who owns the withdrawal, retrying on connectivity trouble,
 * until the answer is definite. Never turns "unknown" into "failed".
 */
export async function reconcileClaim(
  fetchStatus: () => Promise<ClaimStatusResponse | null>,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ClaimOutcome> {
  const attempts = opts.attempts ?? 4;
  const delayMs = opts.delayMs ?? 1500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i++) {
    try {
      const outcome = outcomeFromClaimStatus(await fetchStatus());
      if (outcome.kind !== 'unconfirmed') return outcome;
    } catch {
      // still unknown -- try again
    }
    if (i < attempts - 1) await sleep(delayMs * (i + 1));
  }
  return { kind: 'unconfirmed', message: CLAIM_MESSAGES.unconfirmed };
}

/** Insert/replace a claim in the "Claimed by you" list (same order as the query). */
export function upsertClaimedRow<T extends { id: string; dispatched_at?: string | null }>(
  list: T[] | null | undefined,
  row: T,
): T[] {
  const base = Array.isArray(list) ? list : [];
  const next = base.some((r) => r.id === row.id)
    ? base.map((r) => (r.id === row.id ? row : r))
    : [...base, row];
  return [...next].sort((a, b) => String(a.dispatched_at ?? '').localeCompare(String(b.dispatched_at ?? '')));
}

/** Drop a claimed row from a cached Pending Queue page ({ rows, count }). */
export function removeFromQueuePage<P extends { rows?: Array<{ id: string }>; count?: number | null }>(
  page: P | null | undefined,
  id: string,
): P | null | undefined {
  if (!page?.rows) return page;
  const rows = page.rows.filter((r) => r.id !== id);
  if (rows.length === page.rows.length) return page;
  return { ...page, rows, count: Math.max(0, Number(page.count || 0) - 1) };
}
