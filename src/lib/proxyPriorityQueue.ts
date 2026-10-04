/**
 * Proxy-agent payout priority.
 *
 * A withdrawal initiated by a Proxy Agent on behalf of a partner is URGENT: it
 * sits at the top of the Merchant Agent Payout Queue and, while it is still
 * unclaimed, NO other merchant payout may be claimed.
 *
 * The database is the enforcing authority:
 *   - `trg_set_proxy_withdrawal_urgent` stamps `priority_level='urgent_proxy'`
 *   - `assert_no_urgent_proxy_priority()` row-locks the urgent row inside both
 *     `claim_withdrawal_verified` and `accept_withdrawal_dispatch`
 * This module mirrors that rule so the UI orders, badges and disables
 * identically instead of re-deriving the predicate at each call site.
 */
import { isMerchantQueueActionable, type MerchantQueueRowLike } from './merchantPayoutQueue';

export const URGENT_PROXY_PRIORITY = 'urgent_proxy';

export const PROXY_PRIORITY_BLOCK_MESSAGE =
  'A Priority Proxy Agent withdrawal must be processed first.';

export const PROXY_PRIORITY_WAITING_LABEL =
  'Waiting for Priority Proxy Agent Withdrawal.';

export const URGENT_PROXY_BADGE_LABEL = '🔴 URGENT — PROXY AGENT';

export interface ProxyQueueRowLike extends MerchantQueueRowLike {
  id?: string;
  priority_level?: string | null;
  proxy_partner_id?: string | null;
  initiated_by?: string | null;
  agent_id?: string | null;
  user_id?: string | null;
  reason?: string | null;
  assigned_cashout_agent_id?: string | null;
  created_at?: string | null;
}

/** True when the row was created by a proxy agent on behalf of another party. */
export function isProxyInitiatedWithdrawal(row: ProxyQueueRowLike | null | undefined): boolean {
  if (!row) return false;
  if (row.proxy_partner_id) return true;
  if (String(row.reason || '').startsWith('[Proxy initiated by agent')) return true;
  if (
    row.initiated_by &&
    row.agent_id &&
    row.initiated_by === row.agent_id &&
    row.agent_id !== row.user_id
  ) {
    return true;
  }
  return false;
}

/** True for rows that must be treated as URGENT / PRIORITY #1. */
export function isUrgentProxyWithdrawal(row: ProxyQueueRowLike | null | undefined): boolean {
  if (!row) return false;
  if (String(row.priority_level || '') === URGENT_PROXY_PRIORITY) return true;
  return isProxyInitiatedWithdrawal(row);
}

/** True while an urgent proxy payout is still unclaimed and unresolved. */
export function isUrgentProxyBlocking(row: ProxyQueueRowLike | null | undefined): boolean {
  if (!isUrgentProxyWithdrawal(row)) return false;
  if (!isMerchantQueueActionable(row)) return false; // completed/cancelled/failed → released
  return row?.assigned_cashout_agent_id == null;
}

/** The single urgent proxy payout that holds the queue, oldest first. */
export function findBlockingUrgentProxy<T extends ProxyQueueRowLike>(
  rows: readonly T[] | null | undefined,
): T | null {
  const blocking = (rows || []).filter(isUrgentProxyBlocking);
  if (blocking.length === 0) return null;
  return blocking
    .slice()
    .sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime())[0];
}

/** Urgent proxy payouts first (oldest first), everything else order-preserved. */
export function sortProxyPriorityFirst<T extends ProxyQueueRowLike>(rows: readonly T[]): T[] {
  const urgent = rows
    .filter(isUrgentProxyWithdrawal)
    .slice()
    .sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime());
  const rest = rows.filter((r) => !isUrgentProxyWithdrawal(r));
  return [...urgent, ...rest];
}

/**
 * Why this row cannot be claimed right now, or null when it can.
 * Mirrors the `proxy_priority_hold` error returned by the claim RPCs.
 */
export function proxyPriorityClaimBlockReason(
  row: ProxyQueueRowLike | null | undefined,
  queueRows: readonly ProxyQueueRowLike[] | null | undefined,
): string | null {
  if (!row) return null;
  // The urgent payout itself is always claimable.
  if (isUrgentProxyWithdrawal(row)) return null;
  const blocking = findBlockingUrgentProxy(queueRows);
  if (!blocking) return null;
  if (blocking.id && row.id && blocking.id === row.id) return null;
  return PROXY_PRIORITY_BLOCK_MESSAGE;
}