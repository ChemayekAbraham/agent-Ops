/**
 * Staff-requisition receipt check.
 *
 * The payout gate in `requisitionWalletCredit` and `staff-requisition-decide`
 * uses this module. The pending migration
 * `docs/pending-migrations/staff_requisition_receipt_match.sql` repeats the
 * same rules in `staff_requisition_receipt_verdict_for` so a direct status
 * update cannot mark a payout credited while the gap is open.
 *
 * Sign: amount_unaccounted = typed amount − receipt total.
 *   positive → the person typed more than the receipt shows
 *   negative → the receipt total is higher than the typed amount
 *   null     → the receipt was not read; no figure is invented
 *
 * Payout matches the typed amount (`staff_requisitions.amount`), within
 * UGX 100. An approved amount is reported beside it and does not release
 * payout on its own. A requisition with no requisition receipt is not held:
 * proof of spend often arrives only after the money has been used.
 * Submitting is never blocked here.
 *
 * Already-credited rows keep the gap on record and are not clawed back.
 */

export const RECEIPT_MATCH_TOLERANCE_UGX = 100;

export type ReceiptMatchStatus =
  | "no_receipt"
  | "pending"
  | "matched"
  | "mismatch"
  | "partial"
  | "needs_manual_review";

export interface ReceiptFacts {
  receipt_match_status?: string | null;
  requisition_receipt_paths?: string[] | null;
  receipt_ocr_amount?: number | null;
  receipt_ocr_confidence?: "high" | "low" | string | null;
  receipt_ocr_error?: string | null;
  receipt_ocr_at?: string | null;
  amount?: number | null;
  approved_amount?: number | null;
  receipt_gap_cleared_at?: string | null;
  receipt_gap_cleared_typed_amount?: number | null;
  receipt_gap_cleared_ocr_amount?: number | null;
  wallet_credit_status?: string | null;
}

export interface ReceiptVerdict {
  /** False until the receipt columns exist on the row. Payout is unchanged. */
  active: boolean;
  /** A new wallet credit may proceed. */
  allowed: boolean;
  status: ReceiptMatchStatus;
  typedAmount: number | null;
  ocrAmount: number | null;
  amountUnaccounted: number | null;
  approvedUnaccounted: number | null;
  payoutFrozen: boolean;
  /** A recorded gap remains, including after the wallet was already credited. */
  gapOpen: boolean;
  clearanceApplies: boolean;
  alreadyCredited: boolean;
  message: string;
}

export function receiptColumnsPresent(row: object): boolean {
  return Object.prototype.hasOwnProperty.call(row, "receipt_match_status");
}

export function roundUgx(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function ugx(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}UGX ${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

function sameAmount(a: number | null, b: number | null): boolean {
  return a === b;
}

function inactive(): ReceiptVerdict {
  return {
    active: false,
    allowed: true,
    status: "no_receipt",
    typedAmount: null,
    ocrAmount: null,
    amountUnaccounted: null,
    approvedUnaccounted: null,
    payoutFrozen: false,
    gapOpen: false,
    clearanceApplies: false,
    alreadyCredited: false,
    message: "Receipt matching is not installed on this requisition yet.",
  };
}

export function assessReceiptPayout(row: ReceiptFacts): ReceiptVerdict {
  if (!receiptColumnsPresent(row)) return inactive();

  const paths = Array.isArray(row.requisition_receipt_paths)
    ? row.requisition_receipt_paths.filter((p) => typeof p === "string" && p.length > 0)
    : [];
  const typed = roundUgx(row.amount);
  const approved = roundUgx(row.approved_amount);
  const ocr = roundUgx(row.receipt_ocr_amount);
  const confidence = row.receipt_ocr_confidence === "high" || row.receipt_ocr_confidence === "low"
    ? row.receipt_ocr_confidence
    : null;
  const error = row.receipt_ocr_error ? String(row.receipt_ocr_error).trim() : "";
  const readAt = row.receipt_ocr_at ? String(row.receipt_ocr_at) : "";
  const alreadyCredited = row.wallet_credit_status === "credited";
  const clearedAt = row.receipt_gap_cleared_at ? String(row.receipt_gap_cleared_at) : "";
  const clearedTyped = roundUgx(row.receipt_gap_cleared_typed_amount);
  const clearedOcr = roundUgx(row.receipt_gap_cleared_ocr_amount);

  const base = {
    active: true,
    typedAmount: typed,
    alreadyCredited,
  };

  if (paths.length === 0) {
    return {
      ...base,
      allowed: true,
      status: "no_receipt",
      ocrAmount: null,
      amountUnaccounted: null,
      approvedUnaccounted: null,
      payoutFrozen: false,
      gapOpen: false,
      clearanceApplies: false,
      message: "No requisition receipt is attached. Submit is open and payout is not held for a receipt.",
    };
  }

  let status: ReceiptMatchStatus;
  let amountUnaccounted: number | null = null;
  let officialOcr: number | null = null;

  const pending = !readAt && ocr === null && !error;
  if (pending) {
    status = "pending";
  } else if (error || ocr === null || confidence !== "high" || typed === null) {
    status = "needs_manual_review";
    if (ocr !== null && typed !== null && confidence === "high" && error) {
      // An error means the total was not accepted. Keep it off the official figure.
      amountUnaccounted = null;
    }
  } else {
    officialOcr = ocr;
    amountUnaccounted = typed - ocr;
    const gap = amountUnaccounted;
    if (Math.abs(gap) <= RECEIPT_MATCH_TOLERANCE_UGX) status = "matched";
    else if (gap > 0) status = "partial";
    else status = "mismatch";
  }

  const approvedUnaccounted = approved !== null && officialOcr !== null ? approved - officialOcr : null;
  const clearanceApplies = Boolean(clearedAt)
    && sameAmount(clearedTyped, typed)
    && sameAmount(clearedOcr, officialOcr);
  const gapOpen = status === "pending" || status === "needs_manual_review" || status === "partial" || status === "mismatch";
  const payoutFrozen = gapOpen && !clearanceApplies && !alreadyCredited;
  const allowed = !payoutFrozen;

  return {
    ...base,
    allowed,
    status,
    ocrAmount: officialOcr,
    amountUnaccounted,
    approvedUnaccounted,
    payoutFrozen,
    gapOpen,
    clearanceApplies,
    message: verdictMessage({
      status,
      typed,
      ocr: officialOcr,
      amountUnaccounted,
      payoutFrozen,
      clearanceApplies,
      alreadyCredited,
      gapOpen,
    }),
  };
}

function verdictMessage(v: {
  status: ReceiptMatchStatus;
  typed: number | null;
  ocr: number | null;
  amountUnaccounted: number | null;
  payoutFrozen: boolean;
  clearanceApplies: boolean;
  alreadyCredited: boolean;
  gapOpen: boolean;
}): string {
  if (v.alreadyCredited && v.gapOpen) {
    const gap = v.amountUnaccounted == null
      ? "The receipt could not be matched to the typed amount."
      : `Unaccounted amount is ${ugx(v.amountUnaccounted)} (typed minus receipt).`;
    return `${gap} The wallet was already credited. Nothing is taken back.`;
  }
  if (v.status === "pending") {
    return "Payout is frozen. The receipt has not been read yet, so no amount was recorded. Nothing was credited.";
  }
  if (v.status === "needs_manual_review") {
    const held = v.payoutFrozen
      ? "Payout is frozen until the CFO checks the receipt and clears the gap."
      : "The CFO has cleared this unread receipt.";
    return `The receipt could not be read confidently, so no total was recorded. ${held} Nothing is taken from the wallet.`;
  }
  if (v.status === "matched" && v.typed !== null && v.ocr !== null) {
    const diff = v.amountUnaccounted ?? 0;
    const tail = diff === 0 ? "The figures are the same." : `Difference ${ugx(diff)}, inside UGX ${RECEIPT_MATCH_TOLERANCE_UGX}.`;
    return `Receipt total ${ugx(v.ocr)} matches the typed amount ${ugx(v.typed)}. ${tail}`;
  }
  if ((v.status === "partial" || v.status === "mismatch") && v.typed !== null && v.ocr !== null && v.amountUnaccounted !== null) {
    const direction = v.amountUnaccounted > 0
      ? `Typed amount ${ugx(v.typed)} is ${ugx(v.amountUnaccounted)} more than the receipt total ${ugx(v.ocr)}.`
      : `Receipt total ${ugx(v.ocr)} is ${ugx(Math.abs(v.amountUnaccounted))} more than the typed amount ${ugx(v.typed)}.`;
    const held = v.clearanceApplies
      ? "The CFO has cleared this gap, so payout can proceed. The unaccounted amount stays on the record."
      : "Payout is frozen until the receipt matches or the CFO clears this gap.";
    return `${direction} Unaccounted amount is ${ugx(v.amountUnaccounted)} (typed minus receipt). ${held} Nothing is taken from the wallet.`;
  }
  return v.payoutFrozen
    ? "Payout is frozen until the receipt matches the typed amount or the CFO clears the gap. Nothing was credited."
    : "Receipt check recorded.";
}

/** One line for a review queue. Null when there is nothing to show. */
export function receiptMatchCompact(verdict: ReceiptVerdict): string | null {
  if (!verdict.active || verdict.status === "no_receipt") return null;
  if (verdict.status === "matched") return "Receipt matches";
  if (verdict.status === "pending") return verdict.payoutFrozen ? "Receipt not read — payout frozen" : "Receipt not read";
  if (verdict.status === "needs_manual_review") {
    return verdict.payoutFrozen ? "Receipt needs review — payout frozen" : "Receipt needs review";
  }
  if (verdict.amountUnaccounted == null) {
    return verdict.payoutFrozen ? "Receipt gap — payout frozen" : "Receipt gap";
  }
  const n = Math.abs(verdict.amountUnaccounted).toLocaleString("en-US");
  const signed = verdict.amountUnaccounted < 0 ? `-${n}` : `+${n}`;
  const label = `Unaccounted UGX ${signed}`;
  if (verdict.alreadyCredited) return `${label} — already credited, not taken back`;
  if (verdict.clearanceApplies) return `${label} — CFO cleared`;
  return verdict.payoutFrozen ? `${label} — payout frozen` : label;
}
