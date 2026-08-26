/**
 * Landlord float payout priority.
 *
 * A withdrawal raised to pay a landlord from agent float is treated as urgent:
 * while any unclaimed landlord float payout exists, it sits at the top of the
 * Merchant Agent Payout Queue and no other merchant payout may be claimed.
 *
 * The database is still the enforcing authority for the proxy-agent variant
 * (`assert_no_urgent_proxy_priority`). This module mirrors that rule for
 * landlord float payouts so the UI orders, badges and disables identically.
 */
import { isMerchantQueueActionable, type MerchantQueueRowLike } from './merchantPayoutQueue';

export const LANDLORD_PAYOUT_REASON_PREFIX = 'Landlord float payout';

export const LANDLORD_PRIORITY_BLOCK_MESSAGE =
  'A Priority Landlord payout must be processed first.';

export const LANDLORD_PRIORITY_WAITING_LABEL =
  'Waiting for Priority Landlord Payout.';

export const URGENT_LANDLORD_BADGE_LABEL = '🔴 URGENT — LANDLORD PAYOUT';

export interface LandlordQueueRowLike extends MerchantQueueRowLike {
  id?: string;
  reason?: string | null;
  assigned_cashout_agent_id?: string | null;
  created_at?: string | null;
}

/** True when the row is a landlord float payout. */
export function isLandlordFloatPayout(row: LandlordQueueRowLike | null | undefined): boolean {
  if (!row) return false;
  return String(row.reason || '').startsWith(LANDLORD_PAYOUT_REASON_PREFIX);
}

/** True for rows that must be treated as URGENT / PRIORITY #1. */
export function isUrgentLandlordPayout(row: LandlordQueueRowLike | null | undefined): boolean {
  return isLandlordFloatPayout(row);
}

/** True while a landlord float payout is still unclaimed and unresolved. */
export function isUrgentLandlordBlocking(row: LandlordQueueRowLike | null | undefined): boolean {
  if (!isUrgentLandlordPayout(row)) return false;
  if (!isMerchantQueueActionable(row)) return false;
  return row?.assigned_cashout_agent_id == null;
}

/** The single landlord payout that holds the queue, oldest first. */
export function findBlockingUrgentLandlord<T extends LandlordQueueRowLike>(
  rows: readonly T[] | null | undefined,
): T | null {
  const blocking = (rows || []).filter(isUrgentLandlordBlocking);
  if (blocking.length === 0) return null;
  return blocking
    .slice()
    .sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime())[0];
}

/** Landlord float payouts first (oldest first), everything else order-preserved. */
export function sortLandlordPriorityFirst<T extends LandlordQueueRowLike>(rows: readonly T[]): T[] {
  const urgent = rows
    .filter(isUrgentLandlordPayout)
    .slice()
    .sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime());
  const rest = rows.filter((r) => !isUrgentLandlordPayout(r));
  return [...urgent, ...rest];
}

/**
 * Why this row cannot be claimed right now, or null when it can.
 */
export function landlordPriorityClaimBlockReason(
  row: LandlordQueueRowLike | null | undefined,
  queueRows: readonly LandlordQueueRowLike[] | null | undefined,
): string | null {
  if (!row) return null;
  if (isUrgentLandlordPayout(row)) return null;
  const blocking = findBlockingUrgentLandlord(queueRows);
  if (!blocking) return null;
  if (blocking.id && row.id && blocking.id === row.id) return null;
  return LANDLORD_PRIORITY_BLOCK_MESSAGE;
}
