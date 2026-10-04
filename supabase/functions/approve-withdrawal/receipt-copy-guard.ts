// Receipt-copy guard — POLICY UPDATE (2026-07-16):
//
// The external Gmail archive (weliletenants@gmail.com) is RETIRED. Welile is
// now the sole system of record for payout receipts. Every withdrawal is
// permanently stored inside the platform (withdrawal_requests + receipt_token)
// and surfaced to CFO / Financial Ops via the Receipt Archive module.
//
// This module is kept as a pure, unit-tested no-op so that any future edit
// that tries to re-introduce an internal receipt-copy fan-out is blocked at
// its source. Do NOT restore Gmail forwarding here — mint a Receipt Archive
// record instead.

/** Legacy constant retained only so historical imports keep compiling. */
export const RECEIPT_ARCHIVE_EMAIL = "";

export type ReceiptCopyRecipient = { email: string; role: string };

/** No internal recipients — the platform Receipt Archive is the record. */
export function buildReceiptCopyRecipients(): ReceiptCopyRecipient[] {
  return [];
}

/**
 * Defensive runtime guard. All external receipt copies are permanently
 * disallowed; every recipient is rejected so any accidental caller no-ops.
 */
export function enforceArchiveOnly(
  recipients: ReceiptCopyRecipient[],
): { allowed: ReceiptCopyRecipient[]; rejected: ReceiptCopyRecipient[] } {
  return { allowed: [], rejected: recipients.slice() };
}
