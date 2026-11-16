/**
 * The payout receipt as the black-and-white receipt copy, built from the data the public receipt page loads
 * (get_payout_receipt_by_token). One builder feeds the recipient's page and PDF, the merchant agent's PDF and the Receipt Archive,
 * so they are the same document. It carries no commission line: this is the customer receipt (see receiptContentPolicy).
 */
import { format } from 'date-fns';
import { amountInWords } from '@/lib/partnerReceiptPdf';
import { receiptMethodLabel, receiptQrValue, type PayoutReceiptData } from '@/lib/payoutReceiptPdf';
import { assertReceiptContent } from '@/lib/receiptContentPolicy';
import { prettyPhone, type ReceiptCopyData } from '@/lib/receiptCopy';
import { receiptChecksum } from '@/lib/receiptVerification';

export function copyFromPayoutReceipt(d: PayoutReceiptData, reprint: string | null): ReceiptCopyData {
  assertReceiptContent('customer', false);
  const { isBank, isMoMo, methodLabel } = receiptMethodLabel(d.payout_method);
  const when = d.processed_at ? new Date(d.processed_at) : new Date();

  let paidBy = methodLabel;
  if (isBank) {
    paidBy = [methodLabel, d.bank_name, d.bank_account_number ? `A/c ${d.bank_account_number}` : null, d.bank_account_name ? `(${d.bank_account_name})` : null]
      .filter(Boolean).join(', ');
  } else if (isMoMo) {
    paidBy = `${methodLabel}${d.mobile_money_provider ? ` - ${d.mobile_money_provider}` : ''}, ${prettyPhone(d.mobile_money_number ?? null) || '-'}${
      d.mobile_money_name ? ` (registered name: ${d.mobile_money_name})` : ''}`;
  }
  const agent = [d.processor_name, d.merchant_branch].filter(Boolean).join(', ');
  const amount = Number(d.amount ?? 0);

  return {
    direction: 'out',
    numberLabel: d.receipt_number || d.reference || '',
    dateLabel: format(when, 'dd MMM yyyy, HH:mm'),
    lines: [
      { label: 'Paid to:', value: `${d.recipient_name ?? ''}${d.transaction_type ? ` (${d.transaction_type})` : ''}` },
      { label: 'A sum of Shillings:', value: amountInWords(amount) },
      { label: 'Paid by:', value: paidBy },
      { label: 'Merchant agent:', value: agent || 'Welile' },
      { label: 'Transaction ID (TID):', value: d.reference ?? '' },
    ],
    amount,
    stampDate: format(when, 'dd MMM yyyy').toUpperCase(),
    signatory: null,
    clientSignatureLabel: "Recipient's signature",
    status: 'issued',
    replacedByNo: null,
    replacesEarlier: false,
    voidReason: null,
    // The authenticity checksum is the one the QR carries, so a scan and the printed code agree.
    verifyCode: receiptChecksum(d).toUpperCase(),
    qrText: receiptQrValue(d),
    reprintNote: reprint,
  };
}
