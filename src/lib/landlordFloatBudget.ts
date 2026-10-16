/**
 * Landlord float budget cap — shared types and pure helpers.
 *
 * The CFO sets a daily and a weekly landlord float budget; the COO can only forward rent requests to the CFO
 * while their rent_amount fits in the room left (the smaller of what is left today and this week). Every rule is
 * enforced in the database (supabase/migrations/20261016160000_landlord_float_budget_cap.sql); nothing here
 * decides anything — these helpers only shape the server's answers for the screens.
 */

export interface LandlordFloatPeriod {
  budget_id: string | null;
  amount: number | null;
  /** Approved within the cap (live allocations). */
  used: number;
  /** Approved as miscellaneous (above the cap, CFO-approved). Never eats the cap. */
  misc_used: number;
  approved_count: number;
  /** null when no budget is set for the period. */
  remaining: number | null;
  /** used above amount — set when the CFO lowered the budget below what is already approved. */
  excess: number;
  reason: string | null;
  over_weekly_warning: boolean;
  set_by: string | null;
  set_by_name: string | null;
  set_at: string | null;
}

export type LandlordFloatBlockedReason = 'no_daily_budget' | 'no_weekly_budget' | null;

export interface LandlordFloatPosition {
  day: string;
  week_start: string;
  week_end: string;
  blocked: boolean;
  blocked_reason: LandlordFloatBlockedReason;
  /** What the COO can still approve right now: least(daily remaining, weekly remaining); 0 when blocked. */
  room: number;
  daily: LandlordFloatPeriod;
  weekly: LandlordFloatPeriod;
}

export interface LandlordFloatBudgetStatus extends LandlordFloatPosition {
  today: string;
  can_set_budget: boolean;
  can_decide_misc: boolean;
  can_approve: boolean;
  pending_misc: { id: string; rent_request_id: string; amount: number }[];
  pending_misc_total: number;
}

export interface LandlordFloatSkip {
  id: string | null;
  reason: string;
  message?: string;
}

export interface CooApprovalResult {
  approved: { id: string; rent_amount: number }[];
  over_cap: { id: string; rent_amount: number; room: number; misc_pending: boolean }[];
  skipped: LandlordFloatSkip[];
  approved_total: number;
  room_left: number;
  status: LandlordFloatPosition;
}

export interface MiscRequestResult {
  requested: { id: string; misc_request_id: string; rent_amount: number }[];
  skipped: LandlordFloatSkip[];
  requested_total: number;
}

export interface MiscDecisionResult {
  approved: { id: string; rent_request_id: string; rent_amount: number }[];
  rejected: { id: string; rent_request_id: string }[];
  skipped: LandlordFloatSkip[];
  status: LandlordFloatPosition;
}

export interface ReturnToCooResult {
  returned: { id: string; rent_amount: number }[];
  skipped: LandlordFloatSkip[];
  returned_total: number;
  status: LandlordFloatPosition;
}

export interface SetBudgetResult {
  budget_id: string;
  over_weekly_warning: boolean;
  excess: number;
  status: LandlordFloatPosition;
}

export interface LandlordFloatBudgetHistoryRow {
  id: string;
  period_type: 'daily' | 'weekly';
  period_start: string;
  period_end: string;
  amount: number;
  reason: string | null;
  over_weekly_warning: boolean;
  set_by: string;
  set_by_name: string | null;
  created_at: string;
  superseded_at: string | null;
  superseded_by: string | null;
  is_current: boolean;
  used: number;
  misc_used: number;
  approved_count: number;
  excess: number;
}

export interface LandlordFloatAllocationRow {
  allocation_id: string;
  rent_request_id: string;
  kind: 'within_cap' | 'miscellaneous';
  amount: number;
  budget_date: string;
  approved_by: string;
  approved_by_name: string | null;
  approved_at: string;
  released_at: string | null;
  released_reason: string | null;
  released_to_status: string | null;
  request_status: string;
  tenant_name: string | null;
  landlord_name: string | null;
  agent_name: string | null;
  misc_reason: string | null;
}

export type LandlordFloatMiscStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface LandlordFloatMiscRow {
  id: string;
  rent_request_id: string;
  amount: number;
  reason: string;
  room_at_request: number;
  budget_date: string;
  status: LandlordFloatMiscStatus;
  requested_by: string;
  requested_by_name: string | null;
  requested_at: string;
  cfo_decided_by: string | null;
  cfo_decided_by_name: string | null;
  cfo_decided_at: string | null;
  cfo_note: string | null;
  request_status: string;
  tenant_name: string | null;
  landlord_name: string | null;
  agent_name: string | null;
}

/** Minimum length the server accepts for every reason (miscellaneous ask, over-weekly budget, return, reject). */
export const LANDLORD_FLOAT_MIN_REASON = 10;

/** Error codes the budget functions put at the start of their messages. */
export type LandlordFloatErrorCode = 'NO_BUDGET' | 'OVER_BUDGET' | 'OVER_WEEKLY_REASON_REQUIRED';

export function landlordFloatErrorCode(error: unknown): LandlordFloatErrorCode | null {
  const message = typeof error === 'string' ? error : (error as { message?: string } | null)?.message ?? '';
  const match = /^(NO_BUDGET|OVER_BUDGET|OVER_WEEKLY_REASON_REQUIRED):/.exec(message.trim());
  return (match?.[1] as LandlordFloatErrorCode | undefined) ?? null;
}

/** The message without its leading CODE: prefix, for a toast. */
export function landlordFloatErrorText(error: unknown): string {
  const message = typeof error === 'string' ? error : (error as { message?: string } | null)?.message ?? '';
  return message.replace(/^(NO_BUDGET|OVER_BUDGET|OVER_WEEKLY_REASON_REQUIRED):\s*/, '').trim() || 'Something went wrong';
}

/**
 * Would this rent amount fit in what the COO can still approve? Presentation only (greys out a button);
 * the database re-checks under a lock at approval time.
 */
export function fitsLandlordFloatBudget(
  position: Pick<LandlordFloatPosition, 'blocked' | 'room'> | null | undefined,
  rentAmount: number | null | undefined,
): boolean {
  if (!position || position.blocked) return false;
  const amount = Number(rentAmount) || 0;
  return amount > 0 && amount <= Number(position.room);
}

/** True when a budget change left more approved than the budget allows (the CFO and COO warning). */
export function landlordFloatExcess(position: Pick<LandlordFloatPosition, 'daily' | 'weekly'> | null | undefined) {
  const daily = Number(position?.daily?.excess) || 0;
  const weekly = Number(position?.weekly?.excess) || 0;
  return { daily, weekly, any: daily > 0 || weekly > 0 };
}

/**
 * Picks, in the given order, the requests that fit the room left — the same greedy rule the server applies —
 * so a bulk approval can say up front how many will go through. Presentation only.
 */
export function partitionByLandlordFloatRoom<T extends { id: string; rent_amount: number | null }>(
  rows: T[],
  position: Pick<LandlordFloatPosition, 'blocked' | 'room'> | null | undefined,
): { fits: T[]; overCap: T[] } {
  if (!position || position.blocked) return { fits: [], overCap: [...rows] };
  let room = Number(position.room) || 0;
  const fits: T[] = [];
  const overCap: T[] = [];
  for (const row of rows) {
    const amount = Number(row.rent_amount) || 0;
    if (amount > 0 && amount <= room) {
      fits.push(row);
      room -= amount;
    } else {
      overCap.push(row);
    }
  }
  return { fits, overCap };
}

const ugx = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

/** One-line summary of a COO approval call for a toast: what went, what is held by the budget, what failed. */
export function summarizeCooApproval(result: CooApprovalResult): {
  title: string;
  description?: string;
  variant: 'default' | 'destructive';
} {
  const approved = result.approved.length;
  const held = result.over_cap.length;
  const failed = result.skipped.length;
  const parts: string[] = [];
  if (held > 0) {
    parts.push(
      `${held} held at the COO step: over the landlord float budget left (${ugx(result.room_left)}). ` +
        'Ask the CFO for a miscellaneous approval with a reason.',
    );
  }
  if (failed > 0) parts.push(`${failed} could not be approved: ${result.skipped[0]?.message || result.skipped[0]?.reason}`);
  return {
    title: approved > 0
      ? `✅ ${approved} request${approved === 1 ? '' : 's'} approved (${ugx(result.approved_total)})`
      : 'No requests approved',
    description: parts.join(' ') || undefined,
    variant: approved > 0 ? 'default' : 'destructive',
  };
}
