/**
 * Special Advances — types, request builders and messages for the CFO-only server functions
 * (supabase/migrations/20261028152000_special_advances_functions.sql and 20261028153000_special_advances_payout_repayment.sql).
 *
 * The server is the only authority: it validates, calculates every figure, checks eligibility and the issuance flag,
 * and posts to the ledger. Requests built here carry the agreed TERMS only — never fees, totals or schedules — except
 * `expected_total_repayable`, the server total the CFO confirmed, which the server compares against its own figure.
 */
import type { RateBasis, SpecialAdvanceFrequency } from '@/lib/specialAdvancePreview';

export type SpecialAdvanceStatus = 'pending_approval' | 'approved' | 'rejected' | 'cancelled' | 'disbursed' | 'settled';

export const STATUS_LABEL: Record<SpecialAdvanceStatus, string> = {
  pending_approval: 'Pending approval',
  approved: 'Approved — not paid out',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  disbursed: 'Paid out',
  settled: 'Settled',
};

export type BorrowerRequest =
  | { kind: 'welile_user'; user_id: string }
  | { kind: 'external'; borrower_type: 'individual' | 'entity'; full_name: string; phone: string;
      national_id?: string | null; registration_number?: string | null; organization?: string | null };

export interface TermsRequest {
  principal: number;
  rate_percent: number;
  rate_basis: RateBasis;
  term_days: number;
  frequency: SpecialAdvanceFrequency;
}

export interface ServerScheduleRow {
  number: number;
  due_date: string;
  amount: number;
  access_fee: number;
  registration_fee: number;
  principal: number;
  balance_after: number;
}

export interface ServerSchedule {
  calc_version: string;
  principal: number;
  rate_percent: number;
  rate_basis: RateBasis;
  term_days: number;
  frequency: SpecialAdvanceFrequency;
  start_date: string;
  access_fee: number;
  registration_fee: number;
  total_repayable: number;
  instalments: number;
  instalment_amount: number;
  final_instalment_amount: number;
  first_due_date: string;
  final_due_date: string;
  schedule: ServerScheduleRow[];
}

export interface SpecialAdvanceQuote {
  issuance_enabled: boolean;
  dated_from: string;
  dated_from_is_planned: boolean;
  term_errors: string[];
  schedule: ServerSchedule | null;
  borrower_errors: string[];
  eligibility: string[];
  eligible: boolean;
}

export interface SpecialAdvanceEvent {
  event_type: 'created' | 'approved' | 'rejected' | 'cancelled' | 'disbursed' | 'settled';
  from_status: string | null;
  to_status: string;
  actor_id: string;
  actor_name: string | null;
  reason: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface SpecialAdvance {
  id: string;
  reference: string;
  status: SpecialAdvanceStatus;
  borrower_kind: 'welile_user' | 'external';
  borrower_user_id: string | null;
  borrower_name: string | null;
  external_borrower: { borrower_type: string; full_name: string; phone: string; national_id: string | null; registration_number: string | null } | null;
  principal: number;
  rate_percent: number;
  rate_basis: RateBasis;
  term_days: number;
  frequency: SpecialAdvanceFrequency;
  access_fee: number;
  registration_fee: number;
  total_repayable: number;
  instalments: number;
  purpose: string;
  planned_payout_date: string | null;
  payout_date: string | null;
  payout_method: 'wallet' | 'mobile_money' | 'bank_transfer' | null;
  payout_reference: string | null;
  decision_reason: string | null;
  created_at: string;
  updated_at: string;
  schedule?: Array<{ number: number; due_offset_days: number; due_date: string | null; amount: number; access_fee: number; registration_fee: number; principal: number }>;
  events?: SpecialAdvanceEvent[];
  replayed?: boolean;
}

export interface SpecialAdvancePosition {
  total_repayable: number;
  total_paid: number;
  outstanding: number;
  outstanding_access_fee: number;
  outstanding_registration_fee: number;
  outstanding_principal: number;
  overdue_amount: number;
  overdue_instalments: number;
  instalments: Array<{ number: number; due_date: string | null; amount: number; paid: number; outstanding: number;
    status: 'paid' | 'not_due' | 'overdue' | 'part_paid' | 'due' }>;
}

export interface SpecialAdvanceStatement extends SpecialAdvance {
  position: SpecialAdvancePosition;
  repayments: Array<{ id: string; amount: number; received_date: string; method: string; reference: string; note: string | null; recorded_at: string }>;
}

export interface SpecialAdvanceList {
  issuance_enabled: boolean;
  total_count: number;
  items: SpecialAdvance[];
}

export interface SpecialAdvanceReconciliation {
  a20_ledger_balance: number;
  subledger_outstanding: number;
  difference: number;
  balanced: boolean;
  mismatched_advances: Array<{ reference: string; status: string; subledger_outstanding: number; ledger_balance: number }>;
}

/** The body for `special_advance_quote` / `special_advance_create`: terms only, no figures. */
export function buildRequest(input: {
  borrower: BorrowerRequest | null;
  terms: TermsRequest | null;
  plannedPayoutDate?: string | null;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.borrower) out.borrower = input.borrower;
  if (input.terms) out.terms = { ...input.terms };
  if (input.plannedPayoutDate) out.planned_payout_date = input.plannedPayoutDate;
  return out;
}

export function buildCreateRequest(input: {
  borrower: BorrowerRequest;
  terms: TermsRequest;
  purpose: string;
  plannedPayoutDate?: string | null;
  confirmedTotal: number;
  idempotencyKey: string;
}): Record<string, unknown> {
  return {
    ...buildRequest(input),
    purpose: input.purpose.trim(),
    expected_total_repayable: input.confirmedTotal,
    idempotency_key: input.idempotencyKey,
  };
}

export const PURPOSE_MIN = 15;
export const PURPOSE_MAX = 1000;

const ELIGIBILITY_TEXT: Record<string, string> = {
  OPEN_SPECIAL_ADVANCE: 'This borrower already has an open Special Advance.',
  OVERDUE_AGENT_ADVANCE: 'This borrower has an overdue agent advance with a balance.',
  DEFAULTED_BUSINESS_ADVANCE: 'This borrower has a defaulted business advance with a balance.',
  ACCOUNT_DELETED: 'This account has been deleted.',
  NO_ENABLED_ROLE: 'This account has no enabled role.',
  UNKNOWN_ACCOUNT: 'This account does not exist.',
  SELF_ADVANCE: 'A CFO cannot give a Special Advance to themselves.',
};
export const eligibilityText = (code: string) => ELIGIBILITY_TEXT[code] ?? code.replace(/_/g, ' ').toLowerCase();

const FIELD_TEXT: Record<string, string> = {
  principal: 'principal', rate: 'agreed rate', rate_basis: 'rate basis', term: 'term', frequency: 'repayment frequency',
  start_date: 'payout date', planned_payout_date: 'planned payout date', purpose: 'purpose', borrower: 'borrower',
  borrower_user_id: 'Welile account', borrower_type: 'borrower type', full_name: 'full name', phone: 'phone number',
  national_id: 'National ID (NIN)', registration_number: 'registration number', terms: 'terms', payout_date: 'payout date',
  method: 'payment method', reference: 'transaction reference', amount: 'amount', received_date: 'date received', note: 'note',
};
export const fieldText = (f: string) => FIELD_TEXT[f] ?? f.replace(/_/g, ' ');

const parseDetail = (d?: string): unknown => { try { return d ? JSON.parse(d) : null; } catch { return d ?? null; } };

/** A user-facing message for an error raised by a Special Advances server function. */
export function describeSpecialAdvanceError(err: unknown): string {
  const e = (err ?? {}) as { message?: string; code?: string; details?: string; detail?: string };
  const msg = e.message ?? '';
  const detail = parseDetail(e.details ?? e.detail);
  const list = Array.isArray(detail) ? (detail as string[]) : [];
  if (msg.includes('SELF_ADVANCE')) return ELIGIBILITY_TEXT.SELF_ADVANCE;
  if (/NOT_AUTHORIZED|AUTH_REQUIRED|permission denied/i.test(msg)) {
    return 'Only an enabled CFO account (with its second factor, where required) can do this.';
  }
  if (msg.includes('SPECIAL_ADVANCES_DISABLED')) return 'Special Advance issuance is switched off on the server.';
  if (msg.includes('QUOTE_CHANGED')) {
    const total = (detail as { total_repayable?: number } | null)?.total_repayable;
    return `The server total has changed${total ? ` to UGX ${total.toLocaleString()}` : ''}. Review the schedule and confirm again.`;
  }
  if (msg.includes('BORROWER_NOT_ELIGIBLE')) return list.map(eligibilityText).join(' ') || 'The borrower is not eligible.';
  if (msg.includes('SPECIAL_ADVANCE_INVALID_REQUEST') || msg.includes('SPECIAL_ADVANCE_INVALID_TERMS')) {
    return list.length ? `Check the ${list.map(fieldText).join(', ')}.` : 'Some details need attention.';
  }
  if (msg.includes('OVERPAYMENT_REFUSED')) {
    const out = (detail as { outstanding?: number } | null)?.outstanding;
    return `That is more than is outstanding${out !== undefined ? ` (UGX ${out.toLocaleString()})` : ''}. Overpayments are not accepted.`;
  }
  if (msg.includes('REPAYMENT_REFERENCE_ALREADY_RECORDED')) return 'A repayment with this transaction reference is already recorded.';
  if (msg.includes('IDEMPOTENCY_CONFLICT')) return 'This request was already submitted with different details. Start again.';
  if (msg.includes('STALE_VERSION')) return 'This advance was changed by someone else. Reload it and try again.';
  if (msg.includes('REASON_REQUIRED')) return 'A reason of at least 5 characters is required.';
  if (msg.includes('SPECIAL_ADVANCE_NOT_PENDING')) return 'Only an advance pending approval can be approved or rejected.';
  if (msg.includes('SPECIAL_ADVANCE_NOT_CANCELLABLE')) return 'Only an advance that has not been paid out can be cancelled.';
  if (msg.includes('SPECIAL_ADVANCE_NOT_APPROVED')) return 'Only an approved advance can be paid out.';
  if (msg.includes('SPECIAL_ADVANCE_ALREADY_PAID_OUT')) return 'This advance has already been paid out.';
  if (msg.includes('SPECIAL_ADVANCE_NOT_REPAYABLE')) return 'Repayments can only be recorded for an advance that is paid out and not settled.';
  if (msg.includes('SPECIAL_ADVANCE_NOT_FOUND')) return 'Special Advance not found.';
  return msg || 'The Special Advance request could not be completed.';
}

/** A fresh idempotency key (one per intended action; reused only for a retry of that same action). */
export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
