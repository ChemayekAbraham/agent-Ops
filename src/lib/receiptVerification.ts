/**
 * Receipt authenticity verification.
 *
 * Every payout receipt carries a scannable QR code whose payload encodes the
 * receipt token plus a checksum derived from the receipt's own immutable fields
 * (token, amount, TID reference, and paid-at timestamp). A verifier that scans
 * the code lands on the canonical receipt URL and can recompute the checksum
 * from the server-loaded receipt: if it matches the `c` parameter, the token has
 * not been swapped and the amount/TID/date have not been tampered with.
 *
 * The checksum is a deterministic, dependency-free FNV-1a hash rendered as 8 hex
 * characters. It is not a secret-keyed signature — it is a tamper-evident
 * integrity check that binds the QR contents to the receipt they represent.
 */

export interface ReceiptChecksumInput {
  receipt_token?: string;
  amount?: number;
  reference?: string;
  processed_at?: string;
}

/** FNV-1a 32-bit hash → zero-padded 8-char lowercase hex. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in unsigned 32-bit space.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Canonical string the checksum is computed over. Order and separators are
 * fixed so generation (client + edge) and verification always agree.
 */
function canonicalPayload(data: ReceiptChecksumInput): string {
  return [
    (data.receipt_token || '').trim(),
    String(data.amount ?? ''),
    (data.reference || '').trim(),
    (data.processed_at || '').trim(),
  ].join('|');
}

/** Deterministic 8-char authenticity checksum for a receipt. */
export function receiptChecksum(data: ReceiptChecksumInput): string {
  return fnv1a(canonicalPayload(data));
}

/**
 * Recompute the checksum from a loaded receipt and compare it (case-insensitive)
 * to the value carried in the QR/URL. Returns false when either side is missing.
 */
export function verifyReceiptChecksum(
  data: ReceiptChecksumInput,
  provided?: string | null,
): boolean {
  if (!provided) return false;
  return receiptChecksum(data).toLowerCase() === provided.trim().toLowerCase();
}
