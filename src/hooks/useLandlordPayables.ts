import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Landlord payables under the CFO's weekly-float rule — data layer for the CFO weekly view
 * (migration 20261021100000_landlord_payables_weekly_float).
 *
 * Evidence: the Receipt Archive on the Financial Operations dashboard ONLY. A payout is confirmed only when its
 * completed withdrawal has an archived, accessible receipt whose latest machine check of that exact file is a match,
 * with the transaction ID and amount read from the receipt equal to the withdrawal (and payout) — never because a
 * receipt merely exists, and never from SMS or provider statements.
 *
 * Groups never overlap: confirmed + payable + historical_review + review_only + not_paid = all payouts.
 * `payable_under_review` and `payable_awaiting_receipt` are the two PARTS of `payable` — never add them to it.
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

/** Review exceptions, most serious first. None of them changes an amount, a payout or a withdrawal. */
export type LandlordPayoutException =
  | 'failed_but_paid'
  | 'completed_without_payout'
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

export interface LandlordPayablesWeek {
  week_start: string;
  has_weekly_float: boolean;
  float_set: number | null;
  approved: number | null;
  approved_not_paid: number | null;
  approved_not_paid_count: number | null;
  paid_out: number;
  paid_out_count: number;
  confirmed: number;
  confirmed_count: number;
  payable: number;
  payable_count: number;
  /** Part of `payable` with a review exception — never add to payable. */
  payable_under_review: number;
  payable_under_review_count: number;
  /** Part of `payable` awaiting receipt evidence or checking — never add to payable. */
  payable_awaiting_receipt: number;
  payable_awaiting_receipt_count: number;
  /** Paid before the archive start and not verifiable by it: neither confirmed nor payable (CFO decision). */
  historical_review: number;
  historical_review_count: number;
  /** Not paid out but needing investigation (e.g. completed_without_payout). */
  review_only: number;
  review_only_count: number;
  receipt_unchecked_count: number;
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
  receipt_state: LandlordReceiptState | null;
  receipt_verified: boolean;
  archive_from: string;
  state: LandlordPayoutState;
  /** Within payable only: 'under_review' or 'awaiting_receipt'. */
  payable_class: 'under_review' | 'awaiting_receipt' | null;
  exceptions: LandlordPayoutException[];
  /** The most serious exception (first of `exceptions`). */
  exception: LandlordPayoutException | null;
  under_review: boolean;
}

export interface LandlordPayablesReport {
  as_at: string;
  rule: string;
  archive_from: string;
  totals: {
    payouts: number;
    payouts_amount: number;
    paid_out: number;
    paid_out_count: number;
    confirmed: number;
    confirmed_count: number;
    /** Part of confirmed carrying an exception (e.g. failed_but_paid). */
    confirmed_flagged: number;
    confirmed_flagged_count: number;
    payable: number;
    payable_count: number;
    /** Part of payable — never add to payable. */
    payable_under_review: number;
    payable_under_review_count: number;
    /** Part of payable — never add to payable. */
    payable_awaiting_receipt: number;
    payable_awaiting_receipt_count: number;
    payable_with_weekly_float: number;
    payable_without_weekly_float: number;
    historical_review: number;
    historical_review_count: number;
    review_only: number;
    review_only_count: number;
    not_paid: number;
    not_paid_count: number;
    approved_not_paid: number;
    exception_count: number;
  };
  /** Count and amount per `group:receipt_state`. */
  receipt_states: Record<string, { count: number; amount: number }>;
  by_week: LandlordPayablesWeek[];
  exceptions: Array<{
    payout_id: string;
    landlord: string | null;
    amount: number;
    paid_date: string | null;
    paid_date_source: string | null;
    payout_status: string;
    state: LandlordPayoutState;
    group: 'confirmed' | 'payable' | 'historical_review' | 'review_only' | 'not_paid';
    /** true = part of payable. */
    is_payable: boolean;
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
