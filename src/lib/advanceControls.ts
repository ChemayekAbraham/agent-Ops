/**
 * Agent-advance controls (migration 20261104230000): the codes the database raises, the "[NEW MONEY]" tag a payout
 * needs when it equals an existing balance, and idempotency keys for accounting-only transfers.
 */

export const NEW_MONEY_TAG = '[NEW MONEY]';

export type AdvanceControlCode =
  | 'possible_transfer'
  | 'duplicate_submission'
  | 'needs_destination'
  | 'reversal_exceeds'
  | 'write_off_exceeds'
  | null;

const CODES: Array<[string, Exclude<AdvanceControlCode, null>]> = [
  ['ADVANCE_POSSIBLE_TRANSFER', 'possible_transfer'],
  ['ADVANCE_DUPLICATE_SUBMISSION', 'duplicate_submission'],
  ['ADVANCE_CANCEL_NEEDS_DESTINATION', 'needs_destination'],
  ['REVERSAL_EXCEEDS_ORIGINAL', 'reversal_exceeds'],
  ['ADVANCE_WRITE_OFF_EXCEEDS_APPROVAL', 'write_off_exceeds'],
];

/** Which control refused the request, if any. */
export function advanceControlCode(message: string | null | undefined): AdvanceControlCode {
  const m = String(message ?? '');
  for (const [needle, code] of CODES) if (m.includes(needle)) return code;
  return null;
}

/** The database message without its machine code prefix, for showing to staff. */
export function advanceControlMessage(message: string | null | undefined): string {
  return String(message ?? '').replace(/^(ADVANCE_[A-Z_]+|REVERSAL_[A-Z_]+):\s*/, '').trim();
}

/** The reason as sent: tagged when the CFO confirmed the payout is new money. */
export function withNewMoney(reason: string, newMoney: boolean): string {
  const r = reason.trim();
  if (!newMoney || r.includes(NEW_MONEY_TAG)) return r;
  return `${NEW_MONEY_TAG} ${r}`;
}

/** A fresh idempotency key for one transfer attempt (reused on retries of the same attempt). */
export function newIdempotencyKey(prefix = 'adv-transfer'): string {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}-${id}`;
}

export type TransferDestination = 'replacement' | 'roi' | 'partnership' | 'existing';

/** How each destination maps onto cfo_transfer_agent_advance's arguments. */
export function transferArgs(input: {
  fromAdvanceId: string;
  destination: TransferDestination;
  reason: string;
  idempotencyKey: string;
  amount?: number | null;
  toAdvanceId?: string | null;
  partnerAgentId?: string | null;
  roiPercent?: number | null;
  cycleDays?: number | null;
  crossAccountReason?: string | null;
}) {
  const base = {
    p_from_advance: input.fromAdvanceId,
    p_reason: input.reason.trim(),
    p_idempotency_key: input.idempotencyKey,
    p_amount: input.amount && input.amount > 0 ? input.amount : null,
  };
  if (input.destination === 'existing') {
    return { ...base, p_destination: 'existing_advance', p_to_advance: input.toAdvanceId ?? null,
      p_cross_account_reason: input.crossAccountReason?.trim() || null };
  }
  return {
    ...base,
    p_destination: 'new_advance',
    p_new_agent_id: input.destination === 'partnership' ? input.partnerAgentId ?? null : null,
    p_new_recovery_source: input.destination === 'roi' || (input.destination === 'partnership' && (input.roiPercent ?? 0) > 0) ? 'roi' : null,
    p_new_roi_percent: (input.destination === 'roi' || input.destination === 'partnership') && (input.roiPercent ?? 0) > 0 ? input.roiPercent : null,
    p_new_cycle_days: input.cycleDays && input.cycleDays > 0 ? input.cycleDays : null,
    p_cross_account_reason: input.destination === 'partnership' ? input.crossAccountReason?.trim() || null : null,
  };
}

/* ------------------------------------------------------------------ reconciliation exceptions */

export type AdvanceExceptionKind =
  | 'closed_with_book_balance'
  | 'undocumented_cancellation'
  | 'payout_returned_by_unlinked_correction'
  | 'reversal_exceeds_original'
  | 'duplicate_payout'
  | 'live_book_mismatch';

export interface AdvanceException {
  kind: AdvanceExceptionKind | string;
  severity: 'high' | 'medium' | 'legacy' | string;
  advance_id: string | null;
  agent_id: string | null;
  agent: string | null;
  detail: Record<string, any> | null;
}

export interface AdvanceExceptionReport {
  as_at: string;
  counts: Record<string, number>;
  exceptions: AdvanceException[];
}

/** Plain-language names, in the order the panel lists them. */
export const EXCEPTION_KIND_LABELS: Record<AdvanceExceptionKind, { title: string; meaning: string }> = {
  closed_with_book_balance: {
    title: 'Closed but still on the books',
    meaning: 'The advance is closed but the receivable it created was never cleared.',
  },
  undocumented_cancellation: {
    title: 'Cancelled without a destination',
    meaning: 'A balance was cancelled with no transfer, recoup or approved write-off recorded.',
  },
  payout_returned_by_unlinked_correction: {
    title: 'Payout taken back by an unlinked correction',
    meaning: 'A wallet correction removed an advance payout without being linked to it, so the advance was not reduced.',
  },
  reversal_exceeds_original: {
    title: 'Reversal larger than the original',
    meaning: 'More was taken back than the original payout.',
  },
  duplicate_payout: {
    title: 'Possible duplicate payout',
    meaning: 'The same advance was paid to the wallet more than once.',
  },
  live_book_mismatch: {
    title: 'Balance differs from the books',
    meaning: 'The advance record and the ledger disagree on what is owed.',
  },
};

export function exceptionKindTitle(kind: string): string {
  return (EXCEPTION_KIND_LABELS as Record<string, { title: string }>)[kind]?.title ?? kind.replace(/_/g, ' ');
}

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

/** One line describing the figures behind an exception (amounts in UGX, unformatted numbers rounded). */
export function exceptionSummary(e: AdvanceException, fmt: (n: number) => string): string {
  const d = e.detail ?? {};
  const book = d.book ?? {};
  const bookTotal = (num(book.a10) ?? 0) + (num(book.a11) ?? 0) + (num(book.a20) ?? 0);
  switch (e.kind) {
    case 'closed_with_book_balance':
      return `Status ${d.status ?? '?'}${d.mode ? ` (${d.mode})` : ''}; books still carry ${fmt(bookTotal)}`;
    case 'undocumented_cancellation':
      return `Cancelled ${d.mode ? `as ${d.mode} ` : ''}with ${fmt(num(d.pre_cancel_outstanding) ?? 0)} owed${d.reason ? `: "${d.reason}"` : ''}`;
    case 'payout_returned_by_unlinked_correction':
      return `Paid ${fmt(num(d.payout) ?? 0)}, ${fmt(num(d.returned) ?? 0)} taken back by an unlinked correction`;
    case 'reversal_exceeds_original':
      return `Paid ${fmt(num(d.payout) ?? 0)}, ${fmt(num(d.returned) ?? 0)} taken back: ${fmt(num(d.excess) ?? 0)} too much`;
    case 'duplicate_payout':
      return `${fmt(num(d.amount) ?? 0)} paid twice`;
    case 'live_book_mismatch':
      return `Record says ${fmt(num(d.record_outstanding) ?? 0)}, books say ${fmt(bookTotal)} (difference ${fmt(num(d.difference) ?? 0)})`;
    default:
      return '';
  }
}
