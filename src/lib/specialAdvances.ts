/**
 * Special Advances — types, request builders and messages for the CFO-only server functions
 * (supabase/migrations/20261028152000_special_advances_functions.sql and 20261028153000_special_advances_payout_repayment.sql).
 *
 * The server is the only authority: it validates, calculates every figure, checks eligibility and the issuance flag,
 * and posts to the ledger. Requests built here carry the agreed TERMS only — never fees, totals or schedules — except
 * `expected_total_repayable`, the server total the CFO confirmed, which the server compares against its own figure.
 */
import type { RateBasis, SpecialAdvanceFrequency } from '@/lib/specialAdvancePreview';

export type SpecialAdvanceStatus = 'pending_approval' | 'approved' | 'rejected' | 'cancelled' | 'disbursed' | 'settled' | 'reversed'
  | 'written_off';

export const STATUS_LABEL: Record<SpecialAdvanceStatus, string> = {
  pending_approval: 'Pending approval',
  approved: 'Approved — not paid out',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  disbursed: 'Paid out',
  settled: 'Settled',
  // Phase B (migration 20261102210000): an external payout recorded in error, reversed by an approved correction
  reversed: 'Payout reversed',
  // Phase C (migration 20261102220000): the whole balance written off with a second CFO's approval
  written_off: 'Written off',
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
  event_type: 'created' | 'approved' | 'rejected' | 'cancelled' | 'disbursed' | 'settled' | 'reopened' | 'reversed'
    | 'correction_requested' | 'correction_approved' | 'correction_rejected' | 'correction_withdrawn'
    | 'written_off' | 'write_off_requested' | 'write_off_approved' | 'write_off_rejected' | 'write_off_withdrawn'
    | 'provision_posted' | 'recovery_recorded';
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
  /** Archived proof of an external payout (D1); null for a wallet payout. */
  payout_proof_path?: string | null;
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
  /** Paid out (disbursed or settled). Until then the advance is not a receivable and every outstanding figure is 0.
   *  Optional: sent once migration 20261102200000 is applied. */
  paid_out?: boolean;
  /** The agreed schedule still unpaid, whether or not the advance has been paid out (shown before payout). */
  scheduled_outstanding?: number;
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
  repayments: Array<{ id: string; amount: number; received_date: string; method: string; reference: string; note: string | null; recorded_at: string;
    /** Archived proof of the repayment (D2). */
    proof_path?: string;
    /** Set when an approved correction reversed this repayment: it no longer counts (Phase B). */
    reversed_by_correction?: string | null }>;
  /** Correction requests on this advance, oldest first (Phase B). */
  corrections?: SpecialAdvanceCorrection[];
  /** Phase C: impairment allowance held now (A25 subledger), what a review would require now, and the history. */
  allowance_held?: number;
  provision?: ProvisionLine;
  provision_history?: Array<ProvisionLine & { review: string; review_status: MakerCheckerStatus; decided_at: string | null }>;
  write_offs?: SpecialAdvanceWriteOff[];
  recoveries?: SpecialAdvanceRecovery[];
}

/* ── Impairment, write-off and recovery (Phase C, CFO decisions D7-D10, 2026-11-02; migration 20261102220000) ──
 * Provision reviews and write-offs: one CFO requests, a DIFFERENT CFO approves or rejects, the requester may withdraw
 * (use `correctionActions` for the buttons). The server computes every figure; the browser never sends amounts. */
export type MakerCheckerStatus = CorrectionStatus;

/** D7 minimums, for explaining the server's figures only (the server applies them). */
export const IMPAIRMENT_MINIMUMS: Array<{ label: string; rate: number }> = [
  { label: 'Current', rate: 0 }, { label: '1-30 days past due', rate: 10 }, { label: '31-60 days past due', rate: 25 },
  { label: '61-90 days past due', rate: 50 }, { label: 'Over 90 days past due', rate: 100 },
];

export interface ProvisionLine {
  advance_id: string;
  reference?: string;
  gross_outstanding: number;
  days_past_due: number;
  minimum_rate: number;
  individual_rate: number | null;
  applied_rate: number;
  required_allowance: number;
  held_before: number;
  /** Positive: raise (DR X4 / CR A25); negative: release (DR A25 / CR X4). */
  delta: number;
  ledger_group_id?: string | null;
}

export interface ProvisionPreview {
  as_of_date: string;
  lines: ProvisionLine[];
  total_delta: number;
  allowance_held: number;
}

export interface ProvisionReview {
  id: string;
  reference: string;
  as_of_date: string;
  note: string | null;
  total_delta: number;
  status: MakerCheckerStatus;
  requested_by: string;
  requested_by_name: string | null;
  requested_at: string;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  lines: ProvisionLine[];
  replayed?: boolean;
}

export interface SpecialAdvanceWriteOff {
  id: string;
  reference: string;
  advance_id: string;
  advance_reference: string;
  gross_amount: number;
  allowance_released: number;
  /** gross_amount - allowance_released; negative when the allowance exceeded the balance (the excess is released). */
  net_loss: number;
  reason: string;
  proof_path: string;
  status: MakerCheckerStatus;
  requested_by: string;
  requested_by_name: string | null;
  requested_at: string;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  ledger_group_id: string | null;
  replayed?: boolean;
}

export interface SpecialAdvanceRecovery {
  id: string;
  advance_id: string;
  amount: number;
  received_date: string;
  method: 'mobile_money' | 'bank_transfer';
  reference: string;
  proof_path: string;
  note: string | null;
  ledger_group_id: string;
  recorded_by: string;
  recorded_at: string;
  replayed?: boolean;
}

/** The body for `special_advance_request_provision_review` (and the preview): individual rates only, never amounts. */
export function buildProvisionReviewRequest(input: {
  individualRates?: Record<string, number>;
  note?: string | null;
  idempotencyKey: string;
}): Record<string, unknown> {
  return {
    individual_rates: { ...(input.individualRates ?? {}) },
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    idempotency_key: input.idempotencyKey,
  };
}

/** The body for `special_advance_request_write_off`: the server writes off the whole gross outstanding. */
export function buildWriteOffRequest(input: { reason: string; proofPath: string; idempotencyKey: string }): Record<string, unknown> {
  return { reason: input.reason.trim(), proof_path: input.proofPath, idempotency_key: input.idempotencyKey };
}

/* ── Corrections (Phase B, CFO decisions D11, 2026-11-02; migration 20261102210000) ──────────────────
 * One CFO requests (reason + proof file); a DIFFERENT CFO approves or rejects; the requester may withdraw. Approval
 * posts opposite legs on the original categories; nothing posted is ever edited. Both steps need aal2. */
export type CorrectionKind = 'repayment_reversal' | 'payout_reversal';
export type CorrectionStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';
export type CorrectionDecision = 'approve' | 'reject' | 'withdraw';

export const CORRECTION_KIND_LABEL: Record<CorrectionKind, string> = {
  repayment_reversal: 'Reverse a repayment',
  payout_reversal: 'Reverse an external payout',
};
export const CORRECTION_STATUS_LABEL: Record<CorrectionStatus, string> = {
  pending: 'Awaiting a second CFO',
  approved: 'Approved — posted',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};
export const CORRECTION_REASON_MIN = 20;
export const CORRECTION_REASON_MAX = 1000;

export interface SpecialAdvanceCorrection {
  id: string;
  reference: string;
  advance_id: string;
  advance_reference: string;
  kind: CorrectionKind;
  repayment_id: string | null;
  repayment: { id: string; amount: number; received_date: string; method: string; reference: string } | null;
  amount: number;
  reason: string;
  proof_path: string;
  status: CorrectionStatus;
  requested_by: string;
  requested_by_name: string | null;
  requested_at: string;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  ledger_group_id: string | null;
  replayed?: boolean;
}

/** The body for `special_advance_request_correction`. */
export function buildCorrectionRequest(input: {
  kind: CorrectionKind;
  repaymentId?: string | null;
  reason: string;
  proofPath: string;
  idempotencyKey: string;
}): Record<string, unknown> {
  return {
    kind: input.kind,
    ...(input.kind === 'repayment_reversal' ? { repayment_id: input.repaymentId } : {}),
    reason: input.reason.trim(),
    proof_path: input.proofPath,
    idempotency_key: input.idempotencyKey,
  };
}

/** A correction can be decided by `actorId`: approve / reject only by a different CFO, withdraw only by the requester. */
export function correctionActions(c: Pick<SpecialAdvanceCorrection, 'status' | 'requested_by'>, actorId: string | undefined): CorrectionDecision[] {
  if (c.status !== 'pending' || !actorId) return [];
  return c.requested_by === actorId ? ['withdraw'] : ['approve', 'reject'];
}

export interface SpecialAdvanceList {
  issuance_enabled: boolean;
  total_count: number;
  items: SpecialAdvance[];
}

export interface SpecialAdvanceReconciliation {
  a24_ledger_balance: number;
  subledger_outstanding: number;
  difference: number;
  balanced: boolean;
  mismatched_advances: Array<{ reference: string; status: string; subledger_outstanding: number; ledger_balance: number }>;
  /** Phase C: the allowance (A25, credit balance) against its subledger, and the net receivable (A24 - A25). */
  a25_ledger_balance?: number;
  allowance_subledger?: number;
  allowance_difference?: number;
  net_receivable?: number;
  mismatched_allowances?: Array<{ reference: string; status: string; allowance_subledger: number; allowance_ledger: number }>;
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
  WRITTEN_OFF_SPECIAL_ADVANCE: 'This borrower has a Special Advance that was written off.',
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
  proof_path: 'proof file',
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
  // Phase 4 (CFO decision D5): approval, payout and repayment recording need an authenticator-verified session (aal2).
  if (msg.includes('MFA_REQUIRED')) {
    return 'Verify with your authenticator app first: approving, paying out or recording a repayment needs it.';
  }
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
  // Proof files (CFO decision D1/D2): an external payout and every repayment need an archived receipt or statement.
  if (msg.includes('PROOF_REQUIRED')) return 'Attach the receipt or statement for this payment.';
  if (msg.includes('PROOF_NOT_FOUND')) return 'The uploaded proof could not be found. Upload it again.';
  if (msg.includes('PROOF_ALREADY_USED')) return 'This proof file is already attached to another payment.';
  if (msg.includes('PROOF_PATH_INVALID')) return 'The proof file does not belong to this advance. Upload it again.';
  if (msg.includes('IDEMPOTENCY_CONFLICT')) return 'This request was already submitted with different details. Start again.';
  if (msg.includes('STALE_VERSION')) return 'This advance was changed by someone else. Reload it and try again.';
  // Corrections (Phase B, D11)
  if (msg.includes('SECOND_CFO_REQUIRED')) return 'A different CFO must approve or reject a correction you requested.';
  if (msg.includes('ONLY_REQUESTER_MAY_WITHDRAW')) return 'Only the CFO who requested this correction can withdraw it.';
  if (msg.includes('CORRECTION_ALREADY_PENDING')) return 'This advance already has a correction awaiting a decision.';
  if (msg.includes('CORRECTION_ALREADY_DECIDED')) return 'This correction has already been decided.';
  if (msg.includes('CORRECTION_NOT_FOUND')) return 'Correction not found.';
  if (msg.includes('REPAYMENT_NOT_FOUND')) return 'That repayment is not on this advance.';
  if (msg.includes('REPAYMENT_ALREADY_REVERSED')) return 'This repayment has already been reversed.';
  if (msg.includes('REPAYMENTS_MUST_BE_REVERSED_FIRST')) return 'Reverse every repayment on this advance before reversing its payout.';
  if (msg.includes('PAYOUT_REVERSAL_NOT_SUPPORTED')) return 'A payout to a Welile wallet cannot be reversed here; only an external payout recorded in error.';
  if (msg.includes('SPECIAL_ADVANCE_NOT_CORRECTABLE')) return 'This advance cannot be corrected in its current state.';
  if (msg.includes('BORROWER_HAS_OPEN_ADVANCE')) return 'Reopening this advance would give the borrower two open Special Advances.';
  // Impairment, write-off and recovery (Phase C)
  if (msg.includes('INDIVIDUAL_RATE_BELOW_MINIMUM')) {
    const min = (detail as { minimum_rate?: number } | null)?.minimum_rate;
    return `An individual rate cannot be below the minimum for its days past due${min !== undefined ? ` (${min}%)` : ''}.`;
  }
  if (msg.includes('NOTHING_TO_PROVISION')) return 'Every allowance already matches what is required; there is nothing to post.';
  if (msg.includes('PROVISION_REVIEW_ALREADY_PENDING')) return 'A provision review is already awaiting a second CFO.';
  if (msg.includes('PROVISION_REVIEW_STALE')) return 'Balances changed since this review was requested. Reject or withdraw it and run a new review.';
  if (msg.includes('PROVISION_REVIEW_ALREADY_DECIDED')) return 'This provision review has already been decided.';
  if (msg.includes('PROVISION_REVIEW_NOT_FOUND')) return 'Provision review not found.';
  if (msg.includes('WRITE_OFF_ALREADY_PENDING')) return 'A write-off for this advance is already awaiting a second CFO.';
  if (msg.includes('WRITE_OFF_STALE')) return 'The balance or the allowance changed since this write-off was requested. Withdraw or reject it and request again.';
  if (msg.includes('WRITE_OFF_ALREADY_DECIDED')) return 'This write-off has already been decided.';
  if (msg.includes('WRITE_OFF_NOT_FOUND')) return 'Write-off not found.';
  if (msg.includes('SPECIAL_ADVANCE_NOT_WRITABLE_OFF')) return 'Only a paid-out advance with a balance outstanding can be written off.';
  if (msg.includes('SPECIAL_ADVANCE_NOT_WRITTEN_OFF')) return 'A recovery can only be recorded on a written-off advance.';
  if (msg.includes('RECOVERY_EXCEEDS_WRITTEN_OFF')) {
    const left = (detail as { recoverable?: number } | null)?.recoverable;
    return `That is more than is left to recover${left !== undefined ? ` (UGX ${left.toLocaleString()})` : ''}.`;
  }
  if (msg.includes('REASON_REQUIRED')) {
    return typeof detail === 'string' && detail.includes(String(CORRECTION_REASON_MIN))
      ? `Explain the error in at least ${CORRECTION_REASON_MIN} characters.`
      : 'A reason of at least 5 characters is required.';
  }
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

/* ── Proof files (CFO decision D1/D2) ─────────────────────────────────────────────────────────────── */

/** Private bucket for Special Advances proof files (receipts / statements). */
export const SPECIAL_ADVANCE_PROOF_BUCKET = 'special-advance-proofs';
/** Same limits as the bucket: 10 MB, images or PDF. */
export const SPECIAL_ADVANCE_PROOF_MAX_BYTES = 10 * 1024 * 1024;
const PROOF_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
export const SPECIAL_ADVANCE_PROOF_TYPES = Object.keys(PROOF_EXT);

/**
 * The storage path for a proof of one advance: advances/<advance id>/<uuid>.<ext>, the only shape the server and the
 * bucket policy accept. Throws a user-facing message for a file type or size the bucket refuses.
 */
export function specialAdvanceProofPath(advanceId: string, file: { type: string; size: number }, fileId: string): string {
  const ext = PROOF_EXT[file.type];
  if (!ext) throw new Error('The proof must be a JPEG, PNG or WebP image, or a PDF.');
  if (file.size <= 0 || file.size > SPECIAL_ADVANCE_PROOF_MAX_BYTES) throw new Error('The proof file must be between 1 byte and 10 MB.');
  return `advances/${advanceId}/${fileId}.${ext}`;
}
