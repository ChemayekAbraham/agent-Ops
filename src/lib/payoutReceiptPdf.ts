import { assertReceiptContent } from '@/lib/receiptContentPolicy';
import { receiptChecksum } from '@/lib/receiptVerification';

/** Shape returned by get_payout_receipt / get_payout_receipt_by_token. */
export interface PayoutReceiptData {
  paid: boolean;
  status?: string;
  amount?: number;
  commission?: number | null;
  payout_method?: string;
  reference?: string;
  receipt_token?: string;
  receipt_number?: string;
  transaction_type?: string;
  processed_at?: string;
  recipient_name?: string;
  processor_name?: string;
  processor_phone?: string;
  merchant_branch?: string | null;
  reason?: string;
  bank_name?: string | null;
  bank_account_number?: string | null;
  bank_account_name?: string | null;
  mobile_money_number?: string | null;
  mobile_money_name?: string | null;
  mobile_money_provider?: string | null;
}

export function receiptMethodLabel(payoutMethod?: string) {
  const pm = (payoutMethod || '').toLowerCase();
  const isBank = pm.includes('bank');
  const isMoMo = pm.includes('momo') || pm.includes('mobile') || pm.includes('mtn') || pm.includes('airtel');
  return { isBank, isMoMo, methodLabel: isBank ? 'Bank Transfer' : isMoMo ? 'Mobile Money' : 'Cash' };
}

export function receiptPublicUrl(data: PayoutReceiptData) {
  return data.receipt_token
    ? `https://welileapp.com/r/${data.receipt_token}`
    : (typeof window !== 'undefined' ? window.location.href : '');
}

/**
 * Value encoded into the receipt QR code. It is the canonical receipt URL with
 * an authenticity checksum (`c`) appended so a scan both opens the receipt and
 * carries a tamper-evident code bound to this receipt's token, amount, TID and
 * paid-at timestamp.
 */
export function receiptQrValue(data: PayoutReceiptData) {
  const base = receiptPublicUrl(data);
  if (!base) return '';
  const checksum = receiptChecksum(data);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}c=${checksum}`;
}

/**
 * Generates and downloads the customer-facing payout PDF receipt. Shared by the public receipt page (/r/:token, /receipt/:id),
 * the merchant agent's receipt history page and the company's Receipt Archive, so all of them render the same black-and-white
 * receipt in the paper-book layout (src/lib/receiptCopy.ts). The merchant commission is never printed: this is the customer receipt.
 */
export async function downloadPayoutReceiptPdf(data: PayoutReceiptData) {
  // Policy guard: this is the CUSTOMER receipt, it must never render the merchant agent's commission.
  // copyFromPayoutReceipt draws no commission line, so the rendered content carries none (false).
  assertReceiptContent('customer', false);
  // Loaded on demand: payoutReceiptCopy imports this module's helpers, so a static import would be circular.
  const [{ copyFromPayoutReceipt }, { downloadReceiptCopy }] = await Promise.all([
    import('@/lib/payoutReceiptCopy'),
    import('@/lib/receiptCopy'),
  ]);
  await downloadReceiptCopy(copyFromPayoutReceipt(data, null));
}
