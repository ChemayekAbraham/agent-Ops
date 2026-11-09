/**
 * Partner receipt helpers: amount in words and the PDF that mirrors the paper receipt book layout.
 * Display only. A receipt is evidence of money already in the system; nothing here posts or moves money.
 */
import { format } from 'date-fns';

export interface PartnerReceiptRow {
  id: string;
  receipt_no: number;
  receipt_code: string;
  received_from: string;
  payer_phone: string | null;
  amount: number;
  payment_method: PartnerReceiptMethod;
  instrument_no: string | null;
  drawn_on: string | null;
  branch: string;
  purpose: string;
  received_on: string;
  deposit_request_id: string | null;
  note: string | null;
  status: 'issued' | 'voided';
  issued_by: string;
  issued_by_name: string | null;
  issued_at: string;
  cash_confirmed_at: string | null;
  cash_confirmed_by_name: string | null;
  voided_at: string | null;
  void_reason: string | null;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  delivered_via: string | null;
  delivered_at: string | null;
  verify_token: string;
  pending_correction_id: string | null;
  total_count: number;
}

export type PartnerReceiptMethod = 'cash' | 'cheque' | 'bank_draft' | 'bank_transfer' | 'mobile_money';

export const METHOD_LABEL: Record<PartnerReceiptMethod, string> = {
  cash: 'Cash',
  cheque: 'Cheque',
  bank_draft: 'Bank draft',
  bank_transfer: 'Bank transfer',
  mobile_money: 'Mobile money',
};

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function below1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} hundred`); n %= 100; }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '')); }
  else if (n > 0) parts.push(ONES[n]);
  return parts.join(' and ');
}

/** 150000 -> "One hundred and fifty thousand shillings only". Whole shillings only. */
export function amountInWords(amount: number): string {
  const n = Math.round(amount);
  if (!Number.isFinite(n) || n <= 0) return 'Zero shillings only';
  const scales: [number, string][] = [[1_000_000_000, 'billion'], [1_000_000, 'million'], [1_000, 'thousand']];
  let rest = n;
  const parts: string[] = [];
  for (const [size, name] of scales) {
    if (rest >= size) { parts.push(`${below1000(Math.floor(rest / size))} ${name}`); rest %= size; }
  }
  if (rest > 0) parts.push(parts.length && rest < 100 ? `and ${below1000(rest)}` : below1000(rest));
  const s = parts.join(' ');
  return `${s.charAt(0).toUpperCase()}${s.slice(1)} shillings only`;
}

const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString('en-US')}`;

/** Builds the receipt PDF (A5 landscape-ish slip on A4 portrait width) and returns the jsPDF document. */
export async function buildPartnerReceiptPdf(r: PartnerReceiptRow) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a5', orientation: 'landscape' });
  const W = doc.internal.pageSize.getWidth();
  const M = 12;
  const voided = r.status === 'voided';

  // Header
  doc.setFont('helvetica', 'bold'); doc.setFontSize(26); doc.text('Welile', M, 22);
  doc.setFontSize(7); doc.setFont('helvetica', 'bold');
  doc.text('WELILE TECHNOLOGIES (U) LIMITED', W - M, 12, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.text('P.O Box 167564, Kampala, Uganda', W - M, 16, { align: 'right' });
  doc.text('Email: info@welile.com', W - M, 20, { align: 'right' });
  doc.text('Tel: +256 764 379 713, +256 744 475 573', W - M, 24, { align: 'right' });
  doc.setLineWidth(0.4); doc.line(M, 27, W - M, 27);

  // Title row
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text('RECEIPT', W / 2, 36, { align: 'center' });
  doc.setFontSize(9); doc.setFont('helvetica', 'normal');
  doc.text('No:', M, 36); doc.setFont('helvetica', 'bold'); doc.text(`${r.receipt_code}`, M + 8, 36);
  doc.setFont('helvetica', 'normal');
  doc.text(`Date: ${format(new Date(`${r.received_on}T00:00:00`), 'dd MMM yyyy')}`, W - M, 36, { align: 'right' });

  // Lines (label + value on a dotted underline)
  let y = 48;
  const line = (label: string, value: string) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text(label, M, y);
    const x = M + doc.getTextWidth(label) + 2;
    doc.setLineDashPattern([0.6, 0.8], 0); doc.line(x, y + 1, W - M, y + 1); doc.setLineDashPattern([], 0);
    doc.setFont('helvetica', 'bold');
    const wrapped = doc.splitTextToSize(value, W - M - x - 1) as string[];
    doc.text(wrapped[0] ?? '', x + 1, y - 0.3);
    doc.setFont('helvetica', 'normal');
  };
  line('Received with thanks from:', r.received_from); y += 9;
  line('A sum of Shillings:', amountInWords(r.amount)); y += 9;
  const how = r.payment_method === 'cheque' || r.payment_method === 'bank_draft'
    ? `${METHOD_LABEL[r.payment_method]} no. ${r.instrument_no ?? ''}${r.drawn_on ? `, drawn on ${r.drawn_on}` : ''}`
    : METHOD_LABEL[r.payment_method];
  line('By Cash/Cheque/Draft:', how); y += 9;
  line('Being:', r.purpose); y += 9;
  line('Branch:', r.branch); y += 12;

  // Amount box
  doc.setLineWidth(0.5); doc.roundedRect(M, y - 6, 62, 11, 2, 2);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text(ugx(r.amount), M + 3, y + 1.5);

  // Signatory
  doc.setFontSize(8); doc.setFont('helvetica', 'bold');
  doc.text('For Welile Technologies Limited.', W - M, y - 3, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.text(`Issued by ${r.issued_by_name ?? 'Welile staff'} (authorised signatory)`, W - M, y + 4, { align: 'right' });
  doc.text(format(new Date(r.issued_at), 'dd MMM yyyy HH:mm'), W - M, y + 8, { align: 'right' });

  // Footer
  const H = doc.internal.pageSize.getHeight();
  doc.setFontSize(6.5);
  doc.text('Cheques/Drafts are subject to rectification.', M, H - 14);
  doc.text('Digitally recorded by Welile. This is an internal payment acknowledgement, not a URA fiscal receipt.', M, H - 10);
  doc.text(`Verification code: ${r.verify_token}`, M, H - 6);

  if (voided) {
    doc.setTextColor(200, 30, 30); doc.setFont('helvetica', 'bold'); doc.setFontSize(48);
    doc.text('VOIDED', W / 2, H / 2 + 8, { align: 'center', angle: 20 });
    doc.setFontSize(8); doc.text(r.void_reason ?? '', W / 2, H - 20, { align: 'center' });
    doc.setTextColor(0, 0, 0);
  }
  return doc;
}

export async function downloadPartnerReceiptPdf(r: PartnerReceiptRow) {
  const doc = await buildPartnerReceiptPdf(r);
  doc.save(`${r.receipt_code}.pdf`);
}
