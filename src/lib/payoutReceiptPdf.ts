import jsPDF from 'jspdf';
import QRCode from 'qrcode';
import { formatUGX } from '@/lib/rentCalculations';
import welileWordmark from '@/assets/welile-wordmark.png';
import { assertReceiptContent } from '@/lib/receiptContentPolicy';
import { stampDate } from '@/components/receipts/WelileStamp';
import { receiptChecksum } from '@/lib/receiptVerification';

/**
 * Draws the Welile Technologies official e-stamp as a faint authenticity
 * watermark centred on the receipt. Mirrors the on-screen WelileStamp: blue
 * border, serif company name, red current date flanked by stars, PO Box line.
 */
function drawStampWatermark(doc: jsPDF, cx: number, cy: number, date?: string | Date | null) {
  const BLUE: [number, number, number] = [17, 52, 166];
  const RED: [number, number, number] = [229, 25, 33];
  const boxW = 300;
  const boxH = 132;
  const boxX = cx - boxW / 2;
  const boxY = cy - boxH / 2;

  const GStateCtor = (doc as any).GState;
  const hasGState = typeof GStateCtor === 'function';
  if (hasGState) doc.setGState(new GStateCtor({ opacity: 0.14 }));

  // Border
  doc.setDrawColor(...BLUE);
  doc.setLineWidth(3);
  doc.roundedRect(boxX, boxY, boxW, boxH, 8, 8, 'S');

  // Company name (serif, two lines)
  doc.setTextColor(...BLUE);
  doc.setFont('times', 'bold');
  doc.setFontSize(18);
  doc.text('WELILE TECHNOLOGIES', cx, boxY + 34, { align: 'center' });
  doc.text('LIMITED', cx, boxY + 54, { align: 'center' });

  // Middle row: star — date — star
  const midY = boxY + 88;
  doc.setFontSize(22);
  doc.text('*', boxX + 26, midY + 4, { align: 'center' });
  doc.text('*', boxX + boxW - 26, midY + 4, { align: 'center' });
  doc.setTextColor(...RED);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(24);
  doc.text(stampDate(date), cx, midY + 6, { align: 'center' });

  // Address
  doc.setTextColor(...BLUE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('PO Box 167564 Kampala Uganda', cx, boxY + boxH - 14, { align: 'center' });

  // Reset opacity for anything drawn afterwards.
  if (hasGState) doc.setGState(new GStateCtor({ opacity: 1 }));
}

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
 * Generates and downloads the customer-facing payout PDF receipt. Shared by the
 * public receipt page (/r/:token, /receipt/:id) and the merchant agent's receipt
 * history page so both render identical output. The merchant commission is never
 * printed — this is the customer receipt.
 */
export async function downloadPayoutReceiptPdf(data: PayoutReceiptData) {
  // Policy guard: this is the CUSTOMER receipt — it must never render the
  // merchant agent's commission. We never draw a commission line below, so the
  // rendered content carries no commission (false).
  assertReceiptContent('customer', false);
  const { isBank, isMoMo, methodLabel } = receiptMethodLabel(data.payout_method);
  const publicUrl = receiptPublicUrl(data);
  const paidAt = data.processed_at ? new Date(data.processed_at) : null;
  const dateStr = paidAt
    ? paidAt.toLocaleString('en-UG', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : '—';

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const cardX = 48;
  const cardW = pageW - cardX * 2;
  let y = 56;

  doc.setFillColor(124, 58, 237);
  doc.roundedRect(cardX, y, cardW, 108, 10, 10, 'F');
  doc.setTextColor(255, 255, 255);
  // Welile wordmark on a white pill (the purple logo needs a light backdrop),
  // with the ™ trademark symbol.
  const logoH = 30;
  const logoW = logoH * (640 / 196); // preserve the wordmark aspect ratio
  const tmW = 10;
  const pillPadX = 16;
  const pillPadY = 9;
  const pillW = logoW + tmW + pillPadX * 2;
  const pillH = logoH + pillPadY * 2;
  const pillX = cardX + cardW / 2 - pillW / 2;
  const pillY = y + 12;
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(pillX, pillY, pillW, pillH, 8, 8, 'F');
  try {
    const markImg = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = welileWordmark;
    });
    doc.addImage(markImg, 'PNG', pillX + pillPadX, pillY + pillPadY, logoW, logoH);
    // Trademark symbol next to the wordmark, in brand purple.
    doc.setTextColor(124, 58, 237);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text('™', pillX + pillPadX + logoW + 1, pillY + pillPadY + 8);
  } catch { /* logo optional */ }
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text('Digital Transaction Receipt', cardX + cardW / 2, pillY + pillH + 16, { align: 'center' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('STATUS : COMPLETED', cardX + cardW / 2, pillY + pillH + 34, { align: 'center' });
  y += 138; // clear the 108pt header band + margin (matches original layout)

  doc.setTextColor(17, 24, 39);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(26);
  doc.text(formatUGX(data.amount || 0), cardX + cardW / 2, y, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(107, 114, 128);
  doc.text(`${data.transaction_type || 'Cash Withdrawal'} • ${methodLabel}`, cardX + cardW / 2, y + 18, { align: 'center' });
  y += 44;

  const line = (label: string, value?: string | null) => {
    if (!value) return;
    doc.setDrawColor(229, 231, 235);
    doc.line(cardX, y, cardX + cardW, y);
    y += 18;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(107, 114, 128);
    doc.text(label, cardX, y);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(17, 24, 39);
    doc.text(String(value), cardX + cardW, y, { align: 'right' });
    y += 8;
  };

  line('Transaction Reference', data.receipt_number);
  line('Transaction ID (TID)', data.reference);
  line('Customer', data.recipient_name);
  if (isBank) {
    line('Bank', data.bank_name);
    line('Account Number', data.bank_account_number);
    line('Account Name', data.bank_account_name);
  } else if (isMoMo) {
    line('Provider', data.mobile_money_provider);
    line('Phone Number', data.mobile_money_number);
    line('Registered Name', data.mobile_money_name);
  }
  // Customer-facing receipt: merchant agent identity is intentionally omitted.
  // It remains available in internal admin/audit systems only.
  line('Date & Time', dateStr);

  y += 22;

  try {
    const qrDataUrl = await QRCode.toDataURL(receiptQrValue(data), { margin: 1, width: 220 });
    const qrSize = 120;
    doc.addImage(qrDataUrl, 'PNG', cardX + cardW / 2 - qrSize / 2, y, qrSize, qrSize);
    y += qrSize + 16;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(107, 114, 128);
    doc.text('Scan to verify this receipt', cardX + cardW / 2, y, { align: 'center' });
    y += 24;
  } catch { /* QR is best-effort */ }

  doc.setFontSize(9);
  doc.setTextColor(107, 114, 128);
  doc.text('Powered by Welile Receipts', cardX + cardW / 2, y, { align: 'center' });
  y += 14;
  doc.text('This receipt was generated electronically. No signature is required.', cardX + cardW / 2, y, { align: 'center' });
  y += 12;
  doc.text('Verify at welileapp.com', cardX + cardW / 2, y, { align: 'center' });

  // Authenticity e-stamp watermark, stamped over the receipt body.
  drawStampWatermark(doc, cardX + cardW / 2, 430, data.processed_at);

  doc.save(`welile-receipt-${data.receipt_number || data.reference || 'payout'}.pdf`);
}
