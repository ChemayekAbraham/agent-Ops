import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Landlord Float Payout Budget — data layer for the CFO weekly view
 * (migration 20261021100000_landlord_payables_weekly_float).
 *
 * The landlord PAYABLE is each weekly landlord float the CFO sets, plus CFO-approved miscellaneous approvals above it,
 * less landlord payouts made against it that the Receipt Archive has verified (`floats`, `totals.float_payable`).
 *
 * Evidence: the Receipt Archive on the Financial Operations dashboard ONLY. A payout is confirmed only when its
 * completed withdrawal has an archived, accessible receipt whose latest machine check of that exact file is a match,
 * with the transaction ID and amount read from the receipt equal to the withdrawal (and payout) — never because a
 * receipt merely exists, and never from SMS or provider statements.
 *
 * Payout groups never overlap: confirmed + in_float_unverified + historical_review + review_only + not_paid = all payouts.
 * `in_float_unverified` payouts are already inside their float's payable — never add them to it. Payouts paid without
 * a weekly float and not verified are `historical_review`: neither confirmed nor payable.
 * Dates: `paid_date` is the payout record; `receipt_uploaded_at` is only the receipt upload date; `receipt_date_read`
 * is what the image says (unverified) and is never a payout date.
 */

/** Top-level state of a payout (exactly one). */
export type LandlordPayoutState = 'confirmed' | 'paid_unconfirmed' | 'historical_review' | 'not_paid' | 'failed';

/** The first Receipt Archive check a paid-out payout fails, or `receipt_verified`. */
export type LandlordReceiptState =
  | 'receipt_verified'
  | 'no_archive_record'
  | 'receipt_missing'
  | 'receipt_unchecked'
  | 'receipt_contradicts'
  | 'receipt_unreadable'
  | 'receipt_incomplete'
  | 'receipt_reference_differs'
  | 'receipt_amount_differs'
  | 'receipt_duplicate'
  | 'receipt_alert_open';

/**
 * Review exceptions, most serious first. None of them changes an amount, a payout or a withdrawal.
 * landlord_receipt_reversed: the payout's CURRENT Welile landlord receipt (followed through replacements) is reversed or
 * refunded with no valid replacement. That receipt is never payment evidence; the flag never changes the group.
 */
export type LandlordPayoutException =
  | 'failed_but_paid'
  | 'completed_without_payout'
  | 'landlord_receipt_reversed'
  | 'receipt_contradicts'
  | 'receipt_unreadable'
  | 'receipt_incomplete'
  | 'receipt_reference_differs'
  | 'receipt_amount_differs'
  | 'receipt_duplicate'
  | 'receipt_alert_open'
  | 'paid_amount_differs'
  | 'reference_unusable'
  | 'shared_reference';

/** One weekly landlord float (v_landlord_float_payables). */
export interface LandlordFloatPayable {
  float_id: string;
  week_start: string;
  week_end: string;
  float_set: number;
  /** CFO-approved miscellaneous approvals above the float. */
  misc_approved: number;
  /** float_set + misc_approved. */
  allowance: number;
  within_cap_approved: number;
  approved_count: number;
  approved_not_paid: number;
  approved_not_paid_count: number;
  /** Payouts against this float verified by the Receipt Archive. */
  verified_paid: number;
  verified_count: number;
  /** Paid out but not verified — still inside outstanding_amount. */
  unverified_paid: number;
  unverified_count: number;
  /** The payable: allowance less verified_paid (never below 0). */
  outstanding_amount: number;
  overspent: boolean;
  overspent_amount: number;
  created_at: string;
}

/** Historical review (paid without a weekly float, not verified), by payout week. */
export interface LandlordHistoricalWeek {
  week_start: string;
  payouts: number;
  amount: number;
  flagged: number;
}

export interface LandlordPayoutSettlement {
  payout_id: string;
  rent_request_id: string | null;
  landlord_id: string | null;
  landlord_name: string | null;
  landlord_phone: string | null;
  mobile_money_provider: string | null;
  amount: number;
  payout_status: string;
  created_at: string;
  withdrawal_id: string | null;
  payout_reference: string | null;
  paid_out: boolean;
  paid_at: string | null;
  /** The payout date, from the payout record. */
  paid_date: string | null;
  paid_date_source: 'withdrawal_completed' | 'finops_disbursed' | null;
  has_weekly_float: boolean;
  float_week_start: string | null;
  weekly_budget_id: string | null;
  allocation_kind: string | null;
  report_week_start: string;
  /** What the completed withdrawal actually paid. */
  paid_amount: number | null;
  receipt_token: string | null;
  receipt_file_path: string | null;
  receipt_file_accessible: boolean;
  /** RECEIPT UPLOAD DATE — not the payout date. */
  receipt_uploaded_at: string | null;
  receipt_check_id: string | null;
  receipt_checked_at: string | null;
  receipt_check_result: 'match' | 'mismatch' | 'unverifiable' | string | null;
  receipt_check_code: string | null;
  receipt_tid_read: string | null;
  receipt_amount_read: number | null;
  /** Date as read from the receipt image (unverified) — never used as the payout date. */
  receipt_date_read: string | null;
  blocking_alerts: string[];
  /** The Welile landlord payout receipt sent to the landlord (current one in its replacement chain). NOT payment evidence. */
  landlord_receipt_number: string | null;
  landlord_receipt_status: 'completed' | 'reversed' | 'refunded' | null;
  landlord_receipt_reversed_at: string | null;
  landlord_receipt_replaced: boolean;
  landlord_receipt_reversed: boolean;
  receipt_state: LandlordReceiptState | null;
  receipt_verified: boolean;
  state: LandlordPayoutState;
  /** In-float unverified payouts only: 'under_review' or 'awaiting_receipt'. */
  payable_class: 'under_review' | 'awaiting_receipt' | null;
  exceptions: LandlordPayoutException[];
  /** The most serious exception (first of `exceptions`). */
  exception: LandlordPayoutException | null;
  under_review: boolean;
}

export type LandlordPayoutGroup = 'confirmed' | 'in_float_unverified' | 'historical_review' | 'review_only' | 'not_paid';

export interface LandlordPayablesReport {
  as_at: string;
  rule: string;
  totals: {
    /** THE landlord payable: sum of the floats' outstanding_amount. */
    float_payable: number;
    floats: number;
    floats_open: number;
    float_set: number;
    misc_approved: number;
    allowance: number;
    verified_paid: number;
    /** Inside float_payable — never add to it. */
    unverified_paid: number;
    approved_not_paid: number;
    overspent_floats: number;
    overspent_amount: number;
    payouts: number;
    payouts_amount: number;
    confirmed: number;
    confirmed_count: number;
    confirmed_flagged_count: number;
    /** Inside float_payable — never add to it. */
    in_float_unverified: number;
    in_float_unverified_count: number;
    in_float_under_review_count: number;
    historical_review: number;
    historical_review_count: number;
    review_only: number;
    review_only_count: number;
    not_paid: number;
    not_paid_count: number;
    exception_count: number;
  };
  floats: LandlordFloatPayable[];
  historical_by_week: LandlordHistoricalWeek[];
  /** Count and amount per `group:receipt_state`. */
  receipt_states: Record<string, { count: number; amount: number }>;
  exceptions: Array<{
    payout_id: string;
    landlord: string | null;
    amount: number;
    paid_date: string | null;
    paid_date_source: string | null;
    payout_status: string;
    state: LandlordPayoutState;
    group: LandlordPayoutGroup;
    float_week_start: string | null;
    exception: LandlordPayoutException;
    exceptions: LandlordPayoutException[];
    receipt_state: LandlordReceiptState | null;
    paid_amount: number | null;
    payout_reference: string | null;
    receipt_token: string | null;
    receipt_check_result: string | null;
    receipt_check_code: string | null;
    receipt_tid_read: string | null;
    receipt_amount_read: number | null;
    /** RECEIPT UPLOAD DATE — not the payout date. */
    receipt_uploaded_at: string | null;
    blocking_alerts: string[];
    landlord_receipt_number: string | null;
    landlord_receipt_status: string | null;
    landlord_receipt_reversed_at: string | null;
  }>;
  evidence: {
    source: string;
    receipts_verified: number;
    receipts_unchecked: number;
    last_receipt_uploaded_at: string | null;
  };
  /** Present only when a week was requested. */
  lines: LandlordPayoutSettlement[] | null;
}

export const LANDLORD_PAYABLES_KEY = ['landlord-payables'] as const;

// The generated Database types do not know this function until Lovable regenerates them after the migration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rpc = (fn: string, args?: Record<string, unknown>) => supabase.rpc(fn as any, args as any);

/**
 * @param weekStart  with `weeklyFloat`, also returns that week's payouts (`lines`)
 * @param weeklyFloat true = the CFO weekly float group, false = payouts without a weekly float, omitted = both
 */
export function useLandlordPayablesByWeek(weekStart?: string | null, weeklyFloat?: boolean | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...LANDLORD_PAYABLES_KEY, weekStart ?? 'all', weeklyFloat ?? 'any'],
    enabled: options.enabled ?? true,
    staleTime: 60_000,
    queryFn: async (): Promise<LandlordPayablesReport> => {
      const { data, error } = await rpc('get_landlord_payables_by_week', {
        p_week_start: weekStart ?? null,
        p_weekly_float: weeklyFloat ?? null,
      });
      if (error) throw new Error(error.message);
      return data as unknown as LandlordPayablesReport;
    },
  });
}
