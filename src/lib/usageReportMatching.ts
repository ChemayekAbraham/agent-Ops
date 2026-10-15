/**
 * Requisition usage-report amount matching (display + client pre-check only).
 * The server RPC `submit_requisition_usage_report` is the enforcing authority;
 * this mirrors its rules so the form can show differences as the user types.
 * All amounts are whole UGX. Receipt totals are entered manually, never extracted.
 */
export type RefundStatus = 'made' | 'pending' | 'not_required';

export interface MatchingInput {
  approved: number;
  used: number | null;
  receiptTotal: number | null;
  mismatchExplanation?: string;
  unspentExplanation?: string;
  overspendExplanation?: string;
  refundStatus?: RefundStatus | null;
  refundEvidenceCount?: number;
  refundNotRequiredReason?: string;
}

export interface MatchingResult {
  receiptVsUsed: number | null;   // receipt − used
  unspent: number | null;         // approved − verified spend (receipt), > 0 means balance left
  overspend: number | null;       // verified spend − approved, > 0 means over
  mismatch: boolean;
  hasUnspent: boolean;
  hasOverspend: boolean;
  flagged: boolean;
  problems: string[];             // empty ⇒ can submit
}

const MIN = 10;
const ok = (s?: string) => (s ?? '').trim().length >= MIN;
const num = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n));

export function evaluateUsageMatching(i: MatchingInput): MatchingResult {
  const approved = Math.round(i.approved || 0);
  const used = num(i.used);
  const receipt = num(i.receiptTotal);
  const problems: string[] = [];
  if (used == null || used < 0) problems.push('Enter the amount you used.');
  if (receipt == null || receipt < 0) problems.push('Enter the total shown on your receipts.');
  if (used == null || receipt == null || used < 0 || receipt < 0) {
    return { receiptVsUsed: null, unspent: null, overspend: null, mismatch: false, hasUnspent: false, hasOverspend: false, flagged: false, problems };
  }
  const receiptVsUsed = receipt - used;
  const unspent = approved - receipt;
  const mismatch = receiptVsUsed !== 0;
  const hasUnspent = unspent > 0;
  const hasOverspend = unspent < 0;
  if (mismatch && !ok(i.mismatchExplanation)) problems.push('Explain why the receipt total differs from the amount used (at least 10 characters).');
  if (hasUnspent) {
    if (!ok(i.unspentExplanation)) problems.push('Explain the unspent balance (at least 10 characters).');
    if (!i.refundStatus) problems.push('Choose the refund status for the unspent balance.');
    if (i.refundStatus === 'made' && !(i.refundEvidenceCount && i.refundEvidenceCount > 0)) problems.push('Attach proof of the refund.');
    if (i.refundStatus === 'not_required' && !ok(i.refundNotRequiredReason)) problems.push('Explain why no refund is required (at least 10 characters).');
  }
  if (hasOverspend && !ok(i.overspendExplanation)) problems.push('Explain the amount spent above the approved amount (at least 10 characters).');
  return {
    receiptVsUsed, unspent, overspend: hasOverspend ? -unspent : 0,
    mismatch, hasUnspent, hasOverspend, flagged: mismatch || hasUnspent || hasOverspend, problems,
  };
}
